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
export { OrderedList } from '@tiptap/extension-ordered-list';
export { BulletList } from '@tiptap/extension-bullet-list';
export { HorizontalRule } from '@tiptap/extension-horizontal-rule';
export { Bold } from '@tiptap/extension-bold';
export { Italic } from '@tiptap/extension-italic';
export { Text } from '@tiptap/extension-text';
export { TaskList } from '@tiptap/extension-task-list';
export { TaskItem } from '@tiptap/extension-task-item';
export { Table, TableRow, TableHeader, TableCell } from '@tiptap/extension-table';
export { Markdown } from 'tiptap-markdown';
export { Plugin, PluginKey } from '@tiptap/pm/state';
export { Decoration, DecorationSet } from '@tiptap/pm/view';

import * as yaml from 'js-yaml';
export { yaml };
