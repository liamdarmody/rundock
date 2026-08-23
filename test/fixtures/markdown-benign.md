# Weekly report

Ordinary prose with **bold**, *italic*, `inline code` and a ==highlight== plus a #topic tag.

A tag after every inline construct, because a tag is offered a position by what
precedes it: **done** #project, *soon* #later, `code` #snippet, [[Roadmap]] #plan,
[External](https://example.com/a) #link, ==marked== #done, and plain prose #after.

Not a tag: C#programming, issue#42 and a#b stay as written.

Ampersands: a bare & on its own, beside &amp; written as a reference, and R&D.

## Findings

| Area | Status |
| --- | --- |
| Build | green |
| Tests | green |

### Tight lists

- [ ] Draft the summary
- [x] Send the invoice

1. First
2. Second

- Plain item with **bold** and `code`
- Second item

### Loose lists

- First loose item with **bold**, *nested `code` inside emphasis* and a & ampersand

- Second loose item with [a link](https://example.com/b) and [[Roadmap|an alias]]

1. Loose ordered one with **strong**

2. Loose ordered two

### Loose task list

- [ ] Loose unchecked with **bold**

- [x] Loose checked with `code`

## References

A plain wikilink [[Roadmap]], an aliased one [[Roadmap|the plan]], a relative
note link [the spec](notes/Plan.md), a config link [config](settings.yaml) and an
image ![a diagram](https://example.com/diagram.png "Diagram title").

> [!note] Plain title
> Callout body with **bold**.

```js
const x = 1;
console.log(x);
```

```
plain fenced block
```

> A quote.

[External](https://example.com/page)

---

Done.
