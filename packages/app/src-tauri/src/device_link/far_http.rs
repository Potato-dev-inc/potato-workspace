//! The real `PairRelay` (it lives here, not in `p2p/`: only `p2p/iroh_net.rs` may touch the network there): plain HTTPS calls to the person's own Worker (`relay/worker/src/pair.ts`), with ureq on a
//! blocking thread (the same client the team relay and Live Rooms use). No cookies, no redirects, short waits.
//!
//! Only sealed bytes and hashes of tokens go out. The owner key signs the call that opens a box; it never leaves the
//! credential store and is never sent.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use ed25519_dalek::SigningKey;
use pm_relay_protocol::{auth_header, AUTH_HEADER};
use serde_json::{json, Value};

use crate::p2p::far::{clean_worker_host, Creds, Delivered, PairRelay, RelayErr};

type OwnerKey = Arc<dyn Fn() -> Option<SigningKey> + Send + Sync>;
type HostFn = Arc<dyn Fn() -> Option<String> + Send + Sync>;

pub struct HttpPairRelay {
    owner: OwnerKey,
    my_host: HostFn,
    /// Tests talk to a Worker on this PC over plain http; a real build never does.
    allow_loopback: bool,
    agent: ureq::Agent,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

impl HttpPairRelay {
    pub fn new(owner: OwnerKey, my_host: HostFn) -> Self {
        Self::build(owner, my_host, false)
    }

    /// For tests against a local Worker (`127.0.0.1:<port>` over http).
    #[cfg(test)]
    pub fn for_loopback(owner: OwnerKey, my_host: HostFn) -> Self {
        Self::build(owner, my_host, true)
    }

    fn build(owner: OwnerKey, my_host: HostFn, allow_loopback: bool) -> Self {
        let agent = ureq::AgentBuilder::new()
            .timeout_connect(Duration::from_secs(8))
            .timeout_read(Duration::from_secs(10))
            .timeout_write(Duration::from_secs(10))
            .redirects(0)
            .user_agent("potato-workspace")
            .build();
        Self { owner, my_host, allow_loopback, agent }
    }

    fn base(&self, host: &str) -> Result<String, RelayErr> {
        let host = clean_worker_host(host, self.allow_loopback).ok_or(RelayErr::Refused(400))?;
        let loopback = host.starts_with("127.0.0.1:") || host.starts_with("localhost:");
        Ok(format!("{}://{host}", if loopback { "http" } else { "https" }))
    }

    /// One call on a blocking thread. `signed`: the owner's signature over method, path and body.
    async fn call(&self, method: &'static str, url: String, path: String, headers: Vec<(&'static str, String)>, body: Option<Vec<u8>>, signed: bool) -> Result<Value, RelayErr> {
        let agent = self.agent.clone();
        let key = if signed { (self.owner)() } else { None };
        if signed && key.is_none() {
            return Err(RelayErr::NoFeature);
        }
        let done = tokio::task::spawn_blocking(move || {
            let mut req = agent.request(method, &url);
            for (k, v) in &headers {
                req = req.set(k, v);
            }
            let bytes = body.unwrap_or_default();
            if let Some(key) = &key {
                req = req.set(AUTH_HEADER, &auth_header(key, method, &path, now_ms(), &bytes));
            }
            let sent = if bytes.is_empty() { req.call() } else { req.set("content-type", "application/json").send_bytes(&bytes) };
            match sent {
                Ok(resp) => {
                    let text = resp.into_string().unwrap_or_default();
                    Ok(serde_json::from_str::<Value>(&text).unwrap_or(Value::Null))
                }
                Err(ureq::Error::Status(code, resp)) => {
                    let text = resp.into_string().unwrap_or_default();
                    let error = serde_json::from_str::<Value>(&text).ok().and_then(|v| v.get("error").and_then(Value::as_str).map(str::to_string)).unwrap_or_default();
                    Err((code, error))
                }
                Err(_) => Err((0, String::new())),
            }
        })
        .await
        .map_err(|_| RelayErr::Down)?;
        done.map_err(|(code, error)| match code {
            0 => RelayErr::Down,
            404 => RelayErr::Gone,
            409 if error == "claimed" => RelayErr::Claimed,
            429 | 503 | 507 => RelayErr::Full,
            other => RelayErr::Refused(other),
        })
    }
}

#[async_trait]
impl PairRelay for HttpPairRelay {
    fn my_host(&self) -> Option<String> {
        (self.my_host)()
    }

    async fn create(&self, host: &str, rid: &str, pair_hash: &str, host_hash: &str, ttl_ms: u64) -> Result<(), RelayErr> {
        let url = format!("{}/v1/pair", self.base(host)?);
        let body = json!({ "rid": rid, "pair_hash": pair_hash, "host_hash": host_hash, "ttl_ms": ttl_ms }).to_string().into_bytes();
        // A 404 here means the Worker does not know the route: an older deploy, or no owner key set there.
        match self.call("POST", url, "/v1/pair".into(), Vec::new(), Some(body), true).await {
            Ok(_) => Ok(()),
            Err(RelayErr::Gone) => Err(RelayErr::NoFeature),
            Err(e) => Err(e),
        }
    }

    async fn claim(&self, host: &str, rid: &str, pair_token: &str) -> Result<String, RelayErr> {
        let url = format!("{}/v1/pair/{rid}/claim", self.base(host)?);
        let v = self.call("POST", url, String::new(), vec![("x-pm-pair", pair_token.to_string())], None, false).await?;
        v.get("claim").and_then(Value::as_str).map(str::to_string).ok_or(RelayErr::Refused(200))
    }

    async fn post(&self, host: &str, rid: &str, who: &Creds, dir: char, n: u32, ct: &str) -> Result<(), RelayErr> {
        let url = format!("{}/v1/pair/{rid}/msg", self.base(host)?);
        let body = json!({ "from": dir.to_string(), "n": n, "ct": ct }).to_string().into_bytes();
        self.call("POST", url, String::new(), headers_of(who), Some(body), false).await.map(|_| ())
    }

    async fn poll(&self, host: &str, rid: &str, who: &Creds, for_dir: char, after: u64) -> Result<Vec<Delivered>, RelayErr> {
        let url = format!("{}/v1/pair/{rid}/msg?for={for_dir}&after={after}", self.base(host)?);
        let v = self.call("GET", url, String::new(), headers_of(who), None, false).await?;
        let msgs = v.get("msgs").and_then(Value::as_array).ok_or(RelayErr::Refused(200))?;
        Ok(msgs
            .iter()
            .filter_map(|m| Some(Delivered { index: m.get("i")?.as_u64()?, n: u32::try_from(m.get("n")?.as_u64()?).ok()?, ct: m.get("ct")?.as_str()?.to_string() }))
            .collect())
    }

    async fn delete(&self, host: &str, rid: &str, host_token: &str) -> Result<(), RelayErr> {
        let url = format!("{}/v1/pair/{rid}", self.base(host)?);
        self.call("DELETE", url, String::new(), vec![("x-pm-host", host_token.to_string())], None, false).await.map(|_| ())
    }
}

fn headers_of(who: &Creds) -> Vec<(&'static str, String)> {
    let mut h = Vec::new();
    if let Some(p) = &who.pair {
        h.push(("x-pm-pair", p.clone()));
    }
    if let Some(p) = &who.host {
        h.push(("x-pm-host", p.clone()));
    }
    if let Some(p) = &who.claim {
        h.push(("x-pm-claim", p.clone()));
    }
    h
}
