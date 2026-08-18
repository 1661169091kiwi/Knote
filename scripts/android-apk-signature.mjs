// Keep this an application-signer allowlist. Source-stamp labels deliberately
// do not match either the legacy or Build Tools 37 scheme-prefixed forms.
const APPLICATION_SIGNER_DIGEST = /^(?:Signer #\d+|(?:Signer |V3\.(?:[01] Signer|2 Hybrid (?:Classical|PQC) Signer): )\(minSdkVersion=\d+(?: \(dev release=true\))?, maxSdkVersion=\d+\)|V(?:1|2|3\.0) Signer(?: #\d+)?:) certificate SHA-256 digest: ([0-9a-f]{64})\r?$/gim

export function extractApplicationSignerDigests(report) {
  return [...String(report || '').matchAll(APPLICATION_SIGNER_DIGEST)].map((match) => match[1])
}
