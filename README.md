# Rundock

[![License: PolyForm Perimeter 1.0.0](https://img.shields.io/badge/license-PolyForm%20Perimeter%201.0.0-blue.svg)](LICENSE)
[![Latest release](https://img.shields.io/github/v/release/liamdarmody/rundock)](https://github.com/liamdarmody/rundock/releases)
[![GitHub stars](https://img.shields.io/github/stars/liamdarmody/rundock?style=social)](https://github.com/liamdarmody/rundock/stargazers)

A visual workspace for your AI agent team. Built by someone running their own business, for people running their own. Works with your Claude or ChatGPT subscription.

You run content, ops, sales, admin, and research. When you started, there was nobody else, so the work fell to you. A single chatbot is a single assistant. An agent platform built for developers assumes you can write code. Rundock gives you a team you can actually manage: an org chart of named specialists, parallel conversations you can watch side by side, and delegation that happens in front of you. One beta user described it as having a virtual team of highly paid experts, running in parallel. That is the experience.

Built by [Liam Darmody](https://www.linkedin.com/in/liamdarmody/). Learn more at [rundock.ai](https://rundock.ai/?utm_source=github&utm_medium=readme).

> **Star this repo** if Rundock is useful to you. It is the simplest way to support the project and helps other people running their own businesses find it. [Add a star ->](https://github.com/liamdarmody/rundock)

![Rundock app: an AI agent team org chart with the orchestrator at the top, six specialists, and a routines panel showing scheduled automations](docs/rundock-app-hero.png)

## How Rundock fits

Rundock is two things at once. For you, it is the visual workspace: an org chart, parallel conversations, delegation you can watch happen. Underneath, it is a runtime-agnostic orchestration layer. It catches requests, routes them to the right agent, hands context between them, and keeps the team coordinated. The execution engine is pluggable: Claude Code and Codex today, more later. Your agents are plain markdown you own, so the same team runs on whichever engine you choose, switchable without a rebuild. Rundock owns the coordination, the interface, and the portability. The engine underneath can change. The layer you built stays yours.

## Principles

Five ideas shape every decision in Rundock: **local-first**, **markdown all the way down**, **the human leads**, **the team is the unit of value**, and **built from real use**.

Read the full version at [docs.rundock.ai/principles](https://docs.rundock.ai/principles).

## Getting started

You do not need to write code. You need a subscription that can run agents (Claude Pro or Max; a ChatGPT plan works too, see [Runtimes](#runtimes)) and a folder to call your workspace. Rundock's first-run wizard helps you install Claude Code and sign in, so there is no terminal setup to do by hand.

1. Get a [Claude Pro or Max subscription](https://claude.com/product/claude-code). Claude Code runs your team by default; Rundock's wizard installs and signs you in.
2. Download Rundock for your platform, from [rundock.ai/download](https://rundock.ai/download) or the [releases page](https://github.com/liamdarmody/rundock/releases):

   | Platform | Download |
   |---|---|
   | macOS (Apple Silicon or Intel) | Universal `.dmg` |
   | Windows 10 / 11 (64-bit) | `.exe` installer |
   | Linux | [Build from source](#build-from-source) |

   On Windows the installer is unsigned for now, so SmartScreen shows a one-time prompt: click **More info**, then **Run anyway**.
3. Open Rundock. The first-run wizard installs and signs you into Claude Code, then Doc, the built-in guide, walks you through choosing a workspace and creating your first agents.

## Runtimes

Agents run on **Claude Code** by default. Any specialist can instead run on **Codex**, the official OpenAI CLI, using a ChatGPT plan: add `runtime: codex` to that agent's file (or ask Doc to do it) and leave the model field out so your account's default model applies. Codex agents converse, resume threads, take delegated work from your orchestrator, and review files like any other teammate; they use Codex's built-in sandbox rather than Rundock's permission prompts. The workspace orchestrator always runs on Claude Code.

Codex setup is currently manual (two commands in a terminal): `npm install -g @openai/codex`, then `codex login`. Rundock's Settings show each runtime's status. On Windows, one config line gives Codex agents direct sandboxed file writes; without it, their writes arrive as approval cards. Details at [docs.rundock.ai/concepts/runtimes](https://docs.rundock.ai/concepts/runtimes).

## Build from source

For Linux, or anyone who wants to run Rundock from source. This is also the contributor path.

**Requirements:** Node.js 22+ and Claude Code authenticated (`claude --version` should work in your terminal).

```bash
git clone https://github.com/liamdarmody/rundock.git
cd rundock
npm install
npm start
```

Open [http://localhost:3000](http://localhost:3000) in your browser. To open a specific workspace directly:

```bash
WORKSPACE=/path/to/your/folder npm start
```

To pull updates later, run `npm run update` in the install directory.

## Tech docs

- [ARCHITECTURE.md](ARCHITECTURE.md): the process model, workspace directory, and codebase structure.
- [AGENTS.md](docs/AGENTS.md): the agent file format reference. Frontmatter fields, the markdown body, workspace modes, and a complete example.
- [SKILLS.md](docs/SKILLS.md): the skill file format, discovery, and the assignment model.
- [ROUTINES.md](docs/ROUTINES.md): the schedule format, scheduler behaviour, and where output goes.
- [CONTRIBUTING.md](CONTRIBUTING.md): dev setup, code structure, conventions, changelog standards.
- [CHANGELOG.md](CHANGELOG.md): release history.
- [LICENSE](LICENSE): PolyForm Perimeter 1.0.0.

## Security

The entire stack runs on your machine. Rundock never sends your files, your agents, or your conversations anywhere. The only external connections are made by the runtimes themselves: Claude Code talks to Anthropic's API, and Codex (if you use it) talks to OpenAI's: in each case only the active conversation, processed under your own subscription. Rundock itself makes zero outbound network calls. There is no cloud service, no account to create, no server-side database, no telemetry. Sign-in and keys are managed by each runtime's CLI; Rundock detects sign-in state by checking that a credentials file exists and never reads its contents.

## Licence

PolyForm Perimeter 1.0.0. Fork it, audit it, learn from it. The one thing you cannot do is use the source to build a product that competes with Rundock. See [LICENSE](LICENSE) for the full terms.

## Feedback

Early access. Bugs and ideas welcome at [github.com/liamdarmody/rundock/issues](https://github.com/liamdarmody/rundock/issues).

<!--
================================================================================
OPTIONAL: WALKTHROUGHS SECTION TEMPLATE
================================================================================
If Liam records three short Loom walkthroughs (60-90 seconds each) covering
(a) opening Rundock and seeing the org chart, (b) starting a conversation and
watching delegation happen, (c) adding or editing a skill, paste the section
below directly after the hero screenshot and above the Principles section.
Replace the TODO placeholder URLs with the real Loom share URLs.

## Walkthroughs

Three short videos. Each is around 60 to 90 seconds.

- [Opening Rundock and seeing your team](https://www.loom.com/share/TODO-org-chart): workspace picker, org chart, agent profiles.
- [Starting a conversation and watching delegation happen](https://www.loom.com/share/TODO-delegation): talk to one agent, watch them hand work to a specialist.
- [Adding and editing a skill](https://www.loom.com/share/TODO-skills): what skills are, who they belong to, and how to write one.

================================================================================
END OPTIONAL TEMPLATE
================================================================================
-->
