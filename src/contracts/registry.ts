export const INPUT_CONTRACT_VERSION = "1.0.0";
export const OUTPUT_CONTRACT_VERSION = "1.0.0";
export const STRUCTURED_EXTRACTION_BASELINE = { repository: "https://github.com/artemnoor/kfz-structured-extraction-", commit: "3459f9f9217e964822a1347ba8e92a3629e22fca", schema_version: "1.2.0" } as const;
export function compatibleExtractionVersion(version: string) { const [major, minor] = version.split(".").map(Number); return major === 1 && Number.isFinite(minor) && minor >= 2; }
