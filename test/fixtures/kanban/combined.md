---

kanban-plugin: board
title: Combined constructs
tags:
  - alpha
  - beta

---

## Backlog (5)

**Complete**
- [ ] **Bold title** with a [[Wikilink]] and a [link](https://example.com) #type/feature 2026-09-01
	  Body paragraph one with `inline code`.
	
	  Body paragraph two after a blank line.
- [ ] Card with nested items
	- [ ] nested unchecked
	- [x] nested checked
- [x] **Done card** with a block id ^blk-1
- [-] Cancelled-style card


## Two<br>Line Lane



## Done

- [x] Shipped something #type/ops


***

## Archive

- [x] Archived one #area/x
- [x] Archived two

%% kanban:settings
```
{"kanban-plugin":"board","list-collapse":[false,false,false]}
```
%%