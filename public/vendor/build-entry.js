// Pre-bundling entry point for Rundock's file editor vendor bundle.
//
// This file is the input to esbuild. It re-exports the parts of Tiptap,
// tiptap-markdown, and js-yaml that the editor module under public/editor/
// consumes. esbuild walks these imports and produces public/vendor/tiptap-bundle.mjs,
// a single self-contained ESM file that Rundock loads via the importmap in
// public/index.html.
//
// Rebuild only when versions in package.json change. See package.json for the
// procedure and the spec at 02_Areas/Rundock/Specs/Tiptap-Editor-Implementation.md
// for the rationale.

export { Editor, Node, Mark, Extension, mergeAttributes, InputRule } from '@tiptap/core';
export { default as StarterKit } from '@tiptap/starter-kit';
export { default as HardBreak } from '@tiptap/extension-hard-break';
export { Markdown } from 'tiptap-markdown';

import * as yaml from 'js-yaml';
export { yaml };
