import { describe, expect, it } from 'vitest';
import { normalizeOwnDomain, parsePhonePort } from './own-domain';

const url = (raw: string) => {
  const r = normalizeOwnDomain(raw);
  return r.ok ? r.url : `ERR ${r.error}`;
};

describe('normalizeOwnDomain', () => {
  it('turns a plain name or a full https address into one https origin', () => {
    expect(url('phone.example.com')).toBe('https://phone.example.com');
    expect(url('  HTTPS://Phone.Example.com/a/b?x=1#y ')).toBe('https://phone.example.com');
    expect(url('https://phone.example.com:443/')).toBe('https://phone.example.com');
    expect(url('phone.example.com:8443')).toBe('https://phone.example.com:8443');
    expect(url('https://phone.example.com.')).toBe('https://phone.example.com');
  });
  it('keeps only a port other than the default, and refuses 0 and anything above 65535', () => {
    expect(url('phone.example.com:443')).toBe('https://phone.example.com');
    expect(url('https://phone.example.com:8443/x')).toBe('https://phone.example.com:8443');
    expect(url('phone.example.com:80')).toBe('https://phone.example.com:80');
    expect(url('phone.example.com:65535')).toBe('https://phone.example.com:65535');
    for (const bad of ['phone.example.com:0', 'phone.example.com:65536', 'phone.example.com:99999999999']) expect(url(bad), bad).toBe('ERR connect.domain.err.port');
    for (const bad of ['phone.example.com:', 'phone.example.com:-1']) expect(normalizeOwnDomain(bad).ok, bad).toBe(false);
  });
  it('reads the port on this PC: empty is automatic, 1024 to 65535 otherwise', () => {
    expect(parsePhonePort('')).toEqual({ ok: true, port: null });
    expect(parsePhonePort(' 17425 ')).toEqual({ ok: true, port: 17425 });
    expect(parsePhonePort('1024')).toEqual({ ok: true, port: 1024 });
    expect(parsePhonePort('65535')).toEqual({ ok: true, port: 65535 });
    for (const bad of ['0', '80', '1023', '65536', '-5', '80.5', 'abc', '8 080', '1e4', '0x1F90']) expect(parsePhonePort(bad).ok, bad).toBe(false);
  });
  it('refuses plain http, except for localhost', () => {
    expect(url('http://phone.example.com')).toBe('ERR connect.domain.err.http');
    expect(url('http://localhost:8080/x')).toBe('ERR connect.domain.err.local');
  });
  it('never accepts this computer, in any form', () => {
    for (const name of ['localhost', 'https://localhost:8443/x', 'LOCALHOST', 'app.localhost', 'http://localhost:80']) expect(normalizeOwnDomain(name).ok, name).toBe(false);
  });
  it('refuses a last part that is a number, or starts with 0x', () => {
    for (const name of ['0x7f.1', 'example.123', 'a.b.0x10', '127.1', '2130706433']) expect(normalizeOwnDomain(name).ok, name).toBe(false);
    expect(url('a1.example.com')).toBe('https://a1.example.com');
  });
  it('refuses number addresses, Cloudflare hosts the app already uses, and private names', () => {
    for (const ip of ['192.168.1.5', 'https://10.0.0.1', '127.0.0.1', '[::1]', 'http://127.0.0.1:3000']) expect(url(ip)).toBe('ERR connect.domain.err.ip');
    expect(url('https://a-b.trycloudflare.com')).toBe('ERR connect.domain.err.cloudflare');
    expect(url('pm.me.workers.dev')).toBe('ERR connect.domain.err.cloudflare');
    for (const name of ['nas.local', 'printer.lan', 'intranet', 'a.internal']) expect(url(name)).toBe('ERR connect.domain.err.full');
  });
  it('refuses junk', () => {
    expect(url('')).toBe('ERR connect.domain.err.empty');
    expect(url('ftp://phone.example.com')).toBe('ERR connect.domain.err.scheme');
    for (const junk of ['a@phone.example.com', 'https://a b.example.com', '*.example.com', 'x.example.com:abc', '-a.example.com', 'a..example.com']) expect(normalizeOwnDomain(junk).ok, junk).toBe(false);
    expect(url('x.example.com:0')).toBe('ERR connect.domain.err.port');
    expect(url('x.example.com:70000')).toBe('ERR connect.domain.err.port');
  });
});
