---
title: Writing docs in this workspace
---

# Writing docs in this workspace

Every page here is markdown. Use **bold** for emphasis, `backticks` for code,
and [links](https://example.com) when you send a reader somewhere else.

## Showing a snippet

Wrap the snippet in a fence and name the language on the opening line:

```markdown
Use **bold** for emphasis.

A `code` span, and a [link](https://example.com) beside it.
```

## Showing a fence inside a fence

A page about markdown has to print the fence itself, so open the outer block
with four backticks and the inner one keeps its three:

````markdown
Here is how a snippet looks:

```js
const rate = 0.42;
```

Use **bold** to call out the line that matters.
````

## Tildes

Tildes open a fence too, and a file that uses them should still say so after a
round trip:

~~~text
A tilde fence, left exactly as it was written.
~~~

After every block, **bold** still reads as bold and `code` still reads as code.
