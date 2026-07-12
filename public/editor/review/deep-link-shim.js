// SEAM: swap for the universal-search deep-link at merge time.
//
// The universal-search branch (unmerged while this branch is in flight)
// introduces a navigation/deep-link mechanism for opening a workspace
// location from anywhere in the app. The review feature must not depend on
// an unmerged branch, so this shim carries the agreed signature and always
// reports "not handled"; callers keep their local fallback (in-document
// scroll). At merge, the body becomes a call into the real deep-link
// handler and the fallback stays as the degraded path.
//
// Agreed shape:
//   openWorkspaceLocation({ path, anchor }) -> boolean
//     path:   workspace-relative file path
//     anchor: optional construct/heading anchor within the file
//     returns true when navigation was handled.

export function openWorkspaceLocation() {
  return false;
}
