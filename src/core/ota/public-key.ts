/**
 * Ed25519 public key (raw 32 bytes, base64) that web update manifests must be signed with
 * (src/core/ota/ota.ts). Generated with `node tools/ota-keygen.ts`; the private key lives only in the
 * GitHub Actions secret OTA_SIGNING_KEY. Empty = web updates are off in this build.
 */
export const OTA_PUBLIC_KEY = 'LVRL3t12CrP8FC3zO5cvfWQLJUwI4vo79GgtHhjb8y0=';
