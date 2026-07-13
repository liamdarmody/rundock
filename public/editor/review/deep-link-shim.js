// Workspace navigation seam. Pre-merge this was a stub that always reported
// "not handled"; with universal search on main it is now an injection point
// the host wires to its real navigation (the palette's file-open route).
//
// Contract:
//   openWorkspaceLocation({ path, anchor }) -> boolean
//     path:   workspace-relative file path (null = current file)
//     anchor: optional construct/heading anchor within the file
//     returns true when navigation was handled; callers keep their local
//     fallback (in-document scroll) for unhandled locations.
//
// Same-file locations (path null) intentionally report unhandled: the
// caller's local scroll is the correct behaviour and needs no host help.

let navigator_ = null;

export function registerWorkspaceNavigator(fn) {
  navigator_ = typeof fn === 'function' ? fn : null;
}

export function openWorkspaceLocation(location) {
  if (!navigator_) return false;
  try {
    return navigator_(location) === true;
  } catch {
    return false;
  }
}
