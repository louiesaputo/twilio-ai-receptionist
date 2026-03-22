function getFirstName(fullName) {
  if (!fullName) return "";

  const cleaned = cleanForSpeech(fullName)
    .replace(/^my name is\s+/i, "")
    .replace(/^this is\s+/i, "")
    .replace(/^i am\s+/i, "")
    .replace(/^i'm\s+/i, "")
    .replace(/^it is\s+/i, "")
    .replace(/^this is mr\.?\s+/i, "")
    .replace(/^this is mrs\.?\s+/i, "")
    .replace(/^this is ms\.?\s+/i, "")
    .replace(/^mr\.?\s+/i, "")
    .replace(/^mrs\.?\s+/i, "")
    .replace(/^ms\.?\s+/i, "")
    .trim();

  const parts = cleaned.split(/\s+/).filter(Boolean);

  if (parts.length === 0) return "";

  if (parts.length === 1) return parts[0];

  return parts[0];
}