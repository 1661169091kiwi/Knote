const APPLICATION_SIGNER_DIGEST = /^Signer(?: #\d+|\s+\([^\r\n]+\))? certificate SHA-256 digest:\s*([0-9a-f:]+)/gim

export function extractApplicationSignerDigests(report) {
  return [...String(report || '').matchAll(APPLICATION_SIGNER_DIGEST)].map((match) => match[1])
}
