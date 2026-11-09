//! Content hashes of the tool schemas, so the app (`GET /health`) and the stdio shim can tell
//! exactly which tools differ between two builds instead of comparing a hand-bumped string.

use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

/// `value` as JSON text with every object's keys sorted, so equal schemas hash equally.
pub fn canonical_json(value: &Value) -> String {
    fn sorted(value: &Value) -> Value {
        match value {
            Value::Object(map) => {
                let ordered: BTreeMap<&String, Value> = map.iter().map(|(k, v)| (k, sorted(v))).collect();
                Value::Object(ordered.into_iter().map(|(k, v)| (k.clone(), v)).collect())
            }
            Value::Array(items) => Value::Array(items.iter().map(sorted).collect()),
            other => other.clone(),
        }
    }
    // `serde_json::Map` keeps insertion order only with `preserve_order`; either way we insert sorted.
    sorted(value).to_string()
}

fn hex16(bytes: &[u8]) -> String {
    bytes.iter().take(8).map(|b| format!("{b:02x}")).collect()
}

/// Tool name -> short hash of its name, input schema and output schema, over every tool in the catalog.
pub fn tool_schema_hashes() -> BTreeMap<String, String> {
    super::tools()
        .into_iter()
        .map(|tool| {
            let mut doc = serde_json::json!({ "name": tool.name, "inputSchema": tool.input_schema });
            if let Some(output) = &tool.output_schema {
                doc["outputSchema"] = output.clone();
            }
            let digest = Sha256::digest(canonical_json(&doc).as_bytes());
            (tool.name.to_string(), hex16(&digest))
        })
        .collect()
}

/// One hash over all per-tool hashes (sorted by tool name).
pub fn catalog_hash_of(hashes: &BTreeMap<String, String>) -> String {
    let mut hasher = Sha256::new();
    for (name, hash) in hashes {
        hasher.update(name.as_bytes());
        hasher.update(b"=");
        hasher.update(hash.as_bytes());
        hasher.update(b"\n");
    }
    hex16(&hasher.finalize())
}

/// Hash of the schemas of every tool this build knows.
pub fn catalog_hash() -> String {
    catalog_hash_of(&tool_schema_hashes())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn key_order_does_not_change_the_canonical_form() {
        let a = json!({"b": 1, "a": {"y": [1, 2], "x": 2}});
        let b = json!({"a": {"x": 2, "y": [1, 2]}, "b": 1});
        assert_eq!(canonical_json(&a), canonical_json(&b));
    }

    #[test]
    fn the_catalog_hash_moves_when_one_tool_hash_moves() {
        let mut hashes = tool_schema_hashes();
        assert!(hashes.contains_key("run_agent"));
        let before = catalog_hash_of(&hashes);
        assert_eq!(before, catalog_hash());
        hashes.insert("run_agent".into(), "0000000000000000".into());
        assert_ne!(before, catalog_hash_of(&hashes));
    }
}
