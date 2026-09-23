// C0 and C1 control characters, DEL included. A name holding one (a newline, an
// ANSI escape) could break or rewrite the CLI's table output and the dashboard's
// layout, so names that come in from users are rejected and GitHub profile names
// are stripped.
const CONTROL_CHARS = /\p{Cc}/u;
const CONTROL_CHARS_GLOBAL = /\p{Cc}/gu;

export function hasControlChars(value: string): boolean {
  return CONTROL_CHARS.test(value);
}

export function stripControlChars(value: string): string {
  return value.replace(CONTROL_CHARS_GLOBAL, "");
}
