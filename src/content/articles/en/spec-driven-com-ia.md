---
title: "Spec-driven development with AI: shipping features without losing control"
description: "Write a short spec before asking AI for code, with scope, out of scope and expected files, using ai-kit, a tool I built for this workflow."
slug: "spec-driven-com-ia"
theme: "ia"
order: 2
cover: ""
replaces: ["spec-driven-development"]
---

The most common way to use a coding assistant is to open the chat, describe what you want, paste some context, iterate until it works and merge. It is fast. After a few weeks, the codebase starts showing symptoms: scattered implementations, features that almost match what was asked, changes nobody can quite explain.

The cause is that when you describe a feature in a message, you leave several questions open at once: what to build, what not to build, which files to touch, how to know it is done. The model answers all of them on its own, by inference, without telling you. Sometimes it gets them right. When it does not, you find out in review or in production.

Spec-driven development is the discipline of answering those questions before asking for code. The idea is not mine: GitHub published Spec Kit and AWS built the Kiro editor around specs, each with its own format. Here I describe the flow I use day to day and [ai-kit](https://github.com/jeffev/ai-dev-kit), an open source tool I built to automate that flow on top of Claude Code.

## What a spec is (and is not)

It is not a design document, a user story or a requirements dump. It is a short agreement, for a single feature, that answers four questions: what will be built, what will **not** be built, which tasks make up the implementation, and which files should change.

```markdown
# SPEC-007 — Customer search by email

## Status
draft

## What
Add GET /api/customers/search?email= returning a page of CustomerSummaryDTO.

## Scope
- [ ] CustomerController: new paginated search endpoint
- [ ] CustomerRepository: case-insensitive query by email
- [ ] CustomerSummaryDTO (new): id, name, masked email
- [ ] Integration test for the endpoint

## Out of scope
- Search by name or tax ID
- Changes to customer registration
- Caching the results

## Contracts
### Request
GET /api/customers/search?email={text}&page={n}&size={n}

### Response
Page<CustomerSummaryDTO>

## Stack context
- Controllers only call application services, never repositories directly
- DTOs are records

## Files expected to change
- src/main/java/com/example/customer/web/CustomerController.java
- src/main/java/com/example/customer/persistence/CustomerRepository.java
- src/main/java/com/example/customer/web/CustomerSummaryDTO.java (new)
- src/test/java/com/example/customer/web/CustomerSearchIT.java (new)
```

The most underrated section is **Out of scope**. Every ambiguous request has a halo of neighboring features that the model (and sometimes we) are tempted to build: "while I'm here, I'll add a cache". Writing the boundary down stops that before it starts and gives the model a clear signal of where to stop.

The list of expected files plays a similar role. It limits the blast radius, and any file changed outside it becomes a signal you can check.

## The lifecycle

```text
draft → approve → start → implement → review → close
 (AI)   (human)  (TASK.md)  (AI)       (AI)    (human)
```

One spec, one feature, one bounded AI work session.

### 1. Draft: the AI writes the agreement, not the code

You describe the feature in plain language. The AI breaks it into tasks, proposes the out-of-scope list, estimates the files and fills in the sections. No production code is written at this stage.

```bash
$ ai-kit spec new "search customers by email, paginated, returning a customer summary"
  ....  Calling claude -p to draft spec...
  OK  Spec created: .aikit-specs/draft/SPEC-007-search-customers-by-email.md
  ....  Review and edit the spec, then run:

    ai-kit spec approve SPEC-007
```

In ai-kit, the draft is generated with `claude -p` from the description plus the project's `CLAUDE.md`, which holds the stack's conventions. That is why the *Stack context* section usually comes out with the project's own rules rather than generic ones.

### 2. Approve: the human gate

This is the highest-value step, and it is not a formality. Before any code, someone answers:

- Is the scope the right size?
- Does the task list cover the intent, or is something missing?
- Is the out-of-scope list explicit enough?
- Do the expected files make sense? Is a file that should be there missing?

You edit the file freely and then approve it. ai-kit's `approve` refuses incomplete specs: it checks that *What* is filled in, that there is at least one checklist item, that files are listed and that the *Out of scope* section exists.

```bash
$ ai-kit spec approve SPEC-007
  OK  SPEC-007 approved
  ....  Scope: 4 file(s) (2 new), 4 task(s)
  ....  Run:   ai-kit spec start SPEC-007
```

The approved spec stays in `draft/`, now with status `approved`. It only changes folders in the next step.

### 3. Start: TASK.md as the implementation contract

```bash
$ ai-kit spec start SPEC-007
  OK  SPEC-007 is now active
  OK  TASK.md written at project root
  ....  Claude Code will read TASK.md automatically on session start
  ....  Auditor will log writes to files outside this spec's scope
```

`start` moves the spec to `active/`, records the current commit as the starting point and generates a `TASK.md` at the root with the objective, files, checklist, stack rules and the out-of-scope list under a "do not touch" heading. It also adds `@TASK.md` to `CLAUDE.md`, which is Claude Code's import mechanism, so every new session starts with the task already loaded.

This file solves a real problem with long sessions: context drift. After dozens of tool calls, an agent gradually wanders from the original intent, adding things and touching files it should not. `TASK.md` is the anchor that comes back every session.

### 4. Implement: AI on a leash

Now the agent writes code, inside the contract. The checklist works as a natural session boundary: if work stops halfway, the unchecked items tell the next session exactly where to resume. You can tick an item by hand with `ai-kit spec update tick <N>`.

In ai-kit, Claude Code hooks stay active during implementation: the auditor runs before every file write and blocks critical issues (concatenated SQL, secrets in code, `@Transactional` on a private method, among others), and every written `.java` file triggers `mvnw compile`.

### 5. Review: compliance with the spec, not "good code"

After implementation, the AI compares what was done with what was agreed. It is a compliance check, not a general code review. `review` sends the model the spec and the `git diff` since the start commit and asks for an answer in a fixed format:

```text
$ ai-kit spec review SPEC-007

### Coverage
- ✅ DONE — CustomerController: new endpoint — GET /api/customers/search mapped
- ✅ DONE — CustomerRepository: query by email — findByEmailContainingIgnoreCase
- ✅ DONE — CustomerSummaryDTO — record created
- ❌ MISSING — Integration test for the endpoint — no test file in the diff

### Out-of-scope changes
(none detected)

### Verdict
NEEDS WORK
```

"Does this match what we agreed?" is much faster to answer than "is this good?". A human reviewer is still needed for the second question, but reaches the PR knowing the first one has been answered. Items marked as done are updated to `[x]` in the spec itself.

### 6. Close

```bash
$ ai-kit spec close SPEC-007
```

`close` runs the review again. If the verdict is not ready to close, it asks for confirmation (or accepts `--force`). On closing, it marks the spec as `done`, appends the commits made, moves it to `done/`, deletes `TASK.md` and removes the import from `CLAUDE.md`.

## The history as a side effect

After a few weeks, the `.aikit-specs/done/` folder becomes a record of every feature: what was intended, what was deliberately left out, what was implemented and in which commits.

```text
.aikit-specs/
├── active/
│   └── SPEC-007-search-customers-by-email.md
├── draft/
│   └── SPEC-008-notifications.md
└── done/
    ├── SPEC-001-refresh-token.md
    ├── SPEC-002-product-pagination.md
    └── ...
```

That record answers questions that usually take archaeology: "why is this field optional?", "was the missing cache here intentional?". Unlike a commit message, the spec has the whole context, including what was left out on purpose.

## Why specs improve AI output

Beyond process, a spec improves the model's work because it raises the signal-to-noise ratio of its context:

- **Out of scope prevents over-generation.** Fewer files touched, less to review, fewer side effects.
- **The checklist gives a stopping criterion.** Sessions without one tend to run long and wander; with it, the agent knows when it is done.
- **The file list limits the blast radius.** In large codebases, where the same pattern appears in many places, it lowers the chance of changing the wrong module.

## One spec, one feature

It is the hardest rule to keep under deadline pressure and the most important one. A spec with several features produces an implementation that is hard to review, hard to revert and hard to understand later. The heuristic I use: if a spec goes past six tasks, or if two tasks could ship separately and each would be valuable on its own, split it. An extra spec costs a few minutes; untangling an implementation that mixes two features can cost days.

## When not to use it

Spec-driven development has a cost: roughly ten to fifteen minutes per feature, between writing, reviewing and approving. For a two-line bug fix or a style tweak it is overkill. It is worth it when:

- the change spans several files or modules and scope creep is a real risk;
- the work will span several sessions or several people;
- there will be a formal code review;
- the domain has security, compliance or data-integrity implications.

ai-kit is one way to apply the idea, and you can do all of this with a Markdown file and discipline. What matters is the order: decide what to build, and what not to build, before letting the AI build it.
