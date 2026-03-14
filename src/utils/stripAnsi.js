const ANSI_PATTERN = /[\u001B\u009B][[\]()#;?]*(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007|(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~])/g;

export function stripAnsi(text) {
  if (typeof text !== "string" || text.length === 0) {
    return "";
  }
  return text.replace(ANSI_PATTERN, "");
}

