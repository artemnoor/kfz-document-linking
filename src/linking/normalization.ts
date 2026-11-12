export function normalizeText(input: unknown): string {
  return String(input ?? "").normalize("NFKC").toLocaleLowerCase("ru-RU").replace(/ё/g, "е").replace(/\u00a0|\u202f/g, " ").replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
}

/** Token normalization is separator-insensitive but never uses substring matching. */
export function normalizeIdentifier(input: unknown): string {
  return normalizeText(String(input ?? "").replace(/№/gu, " ")).replace(/^(договор|доп соглашение|д с|счет|сч|акт|номер)\s*/u, "").replace(/(?:^|\s)от\s+\d{1,2}\s+(?:\d{1,2}|\p{L}+)\s+\d{4}(?=\s|$)/gu, " ").trim().replace(/\s+/g, " ");
}

export type MatchKind = "exact" | "normalized" | "approximate" | "none";
export function compareIdentifier(a: unknown, b: unknown): MatchKind {
  const rawA = String(a ?? "").normalize("NFKC").toLocaleLowerCase("ru-RU").trim();
  const rawB = String(b ?? "").normalize("NFKC").toLocaleLowerCase("ru-RU").trim();
  if (!rawA || !rawB) return "none";
  if (rawA === rawB) return "exact";
  return normalizeIdentifier(rawA) === normalizeIdentifier(rawB) ? "normalized" : "none";
}

export function compareDescription(a: unknown, b: unknown): { kind: MatchKind; score: number } {
  const rawA = normalizeText(a), rawB = normalizeText(b);
  if (!rawA || !rawB) return { kind: "none", score: 0 };
  if (rawA === rawB) return { kind: "exact", score: 1 };
  const tokensA = new Set(rawA.split(" ").filter(t => t.length > 2));
  const tokensB = new Set(rawB.split(" ").filter(t => t.length > 2));
  if (!tokensA.size || !tokensB.size) return { kind: "none", score: 0 };
  const numericA = [...rawA.matchAll(/\d+(?:[.,]\d+)?/g)].map(m => m[0].replace(",", ".")).sort();
  const numericB = [...rawB.matchAll(/\d+(?:[.,]\d+)?/g)].map(m => m[0].replace(",", ".")).sort();
  if (numericA.length && numericB.length && numericA.join("|") !== numericB.join("|")) return { kind: "none", score: 0 };
  const overlap = [...tokensA].filter(t => tokensB.has(t)).length;
  const score = overlap / new Set([...tokensA, ...tokensB]).size;
  return { kind: score >= .78 ? "normalized" : score >= .58 && overlap >= 3 ? "approximate" : "none", score };
}

export function valueOf(extracted: any): unknown { return extracted?.value ?? extracted?.source_value ?? null; }
export function usable(extracted: any): boolean { return !!extracted && extracted.status === "extracted" && typeof extracted.confidence === "number" && extracted.confidence >= 0.65 && valueOf(extracted) !== null && String(valueOf(extracted)).trim() !== ""; }
