---
title: "What AI won't do for you: how I reviewed my templates and e-books before selling them"
description: "Behind the scenes of products built with AI: what I checked before selling, the mistakes the AI made, and how I scale review to the risk of each change."
slug: "o-que-a-ia-nao-faz"
theme: "ia"
order: 4
cover: ""
replaces: ["o-que-a-ia-nao-faz", "ai-for-developers"]
---

I put Next.js templates and technical e-books on sale, and I used AI heavily to build all of it. I know the question that comes to mind: "if AI made it, is it worth anything?"

It is a fair question. AI produces code and text in volume. What it does not guarantee is that any of it works, is correct, and can be sold to someone else with my name on it. That part is still engineering work, and it is what I want to talk about.

## What I put on sale

Nine templates, all built with Next.js 16, Tailwind CSS 4 and shadcn/ui, sold in my Payhip store, each with a live demo you can try before buying:

- **Kairo Admin**: an admin dashboard with 23 screens
- **Kairo AI Starter**: a SaaS starter with login, AI chat, credits and Stripe
- **Kairo Blocks**: 61 landing page blocks
- **Kairo Estate**: a real estate site with a map and URL-driven filters
- **Kairo Mail**: 32 email templates built with React Email
- **Kairo Studio**: an agency and portfolio site
- **Kairo Invoice**: invoicing with PDFs, payment links and Stripe
- **Kairo Booking**: appointment scheduling with a public booking page and Stripe deposits
- **Kairo Directory**: a product directory with paid submissions and featured listings

And technical e-books in Portuguese, each one teaching how to build a kind of project. They started on Hotmart and are now on Amazon, through KDP.

## AI as the team, me as the tech lead

I used Claude Code as a very fast team: it writes the code, runs the build and the tests, takes the screenshots, assembles the PDFs. My role was the one I have had as a tech lead for years: decide what to build, review everything, say no, and own what ends up in the buyer's hands.

The bottleneck moved. Writing code stopped being the slow part; reviewing and deciding became the slow part. Anyone who has led a team knows the feeling. The difference is that the review has to keep up with a team that delivers a lot, without getting sloppy.

The mental model that works for me: AI is a fast colleague who knows a lot and is sometimes overconfident. I would not merge a senior engineer's PR without reading it, or apply a config someone pasted in chat to production without checking it. The bar for what AI produces is the same.

## What I checked before selling

### The templates

- A production build with no errors, with TypeScript type checking running alongside.
- A from-scratch install from the zip, in a clean folder, exactly as the buyer receives it. A template that only works on its author's machine is not a product.
- Automated interaction tests on the demos: 16 on Kairo Estate and 23 on Kairo Studio, clicking filters, forms and navigation the way a person would.
- On Kairo AI Starter, which handles money: sign-up, chat, credit consumption, blocking when the balance runs out, password recovery, isolation between users (one cannot see another's data), and a signed, idempotent Stripe webhook (the same payment notified twice does not credit twice).
- A visual review in light mode, dark mode and on a phone.
- The demo photos, one by one. On Kairo Studio, I replaced three that showed third-party brands. AI does not notice that kind of problem; an attentive customer does.

### The e-books

The most important rule: every technical claim is checked against the code before it goes into the PDF. Every quoted snippet, every number, every "the template already does this". If the book says a form has validation, I open the file and check. Technical material that gets facts wrong loses the reader's trust on page one.

## Where the AI got it wrong (and I caught it)

### 1. Wrong facts, stated with full confidence

A draft said a template had six forms. There were five: the sixth type existed in the code, but no screen used it. It looks like a detail, but it is exactly the kind of error that makes a buyer doubt everything else.

This has a name: hallucination. The model produces something fluent, confident and wrong, in the same tone it uses when it is right. The signal for "I am making this up" is identical to the signal for "I am sure", which is why it is the most dangerous flaw for professional use.

### 2. A bug that would make the SaaS give credits away

On Kairo AI Starter, if a user pressed "Stop" in the middle of a chat response, the response was not charged. Anyone building a SaaS on top of the template would be paying for the AI out of their own pocket with every click. The fix: the server keeps generating even after the browser disconnects, saves the response and charges the credits. I released version 1.0.1 and replaced the file in the store.

That bug does not show up in any happy-path test. It only shows up for someone who asks "what if the user does this halfway through?", which is the question a tech lead asks out of habit.

### 3. Sales copy with a false promise

Back when the e-books were on Hotmart, I used the AI-generated sales page the platform offers. The first version said the code was "battle-tested in production". That was not true: it was a new template. I fixed it before promoting anything. Any text that speaks in my name goes through me, even when the platform hands it over ready-made.

## Review in proportion to risk

Reviewing everything with the same intensity does not scale. What I do is scale the effort to the risk of the change and to the kinds of things AI tends to get wrong.

Errors are not evenly spread. The risk is higher for exact APIs of specific library versions, anything after the model's training cutoff, poorly documented frameworks, security configurations with many valid-looking variations, interactions between two libraries, and arithmetic done in the middle of prose. It is lower for well-known algorithms, the standard library of popular languages, code transformation, and explaining code you provided yourself.

In practice, I split it like this:

- **Low risk, quick read**: boilerplate, test fixtures, refactoring with clear intent, converting between languages.
- **Medium risk, careful read with tests running**: business logic, database queries, API integration.
- **High risk, check against the primary source**: authentication, CORS, cryptography, dependency versions and changelogs, infrastructure that touches production, and any code handling money, personal data or access control.

Kairo AI Starter fell entirely in the third band, which is why credits, user isolation and the Stripe webhook got more scrutiny than anything else.

## Agents: the minimum permissions needed

An agent is a model that acts: it reads files, runs commands, calls APIs, observes the result and decides the next step, in a loop, until it is done. That is different from a chat, and it fails differently: if its reasoning at step 3 is wrong, steps 4 through 10 can proceed with full confidence in the wrong direction.

So I treat an agent the way I treat a service account, with least privilege. For exploring and answering questions, read-only. For the development loop, writing inside the project and running tests, with no push and no access to real databases. For any action with effects outside the machine (push, database writes, external API calls, publishing), human approval at every step. The gap between an agent that only reads and one that writes is huge, and it should be a deliberate decision.

## The code has to be yours

There is a way of using AI that closes tasks quickly and piles up invisible debt: accepting what it produces without understanding it, iterating by prompt instead of by comprehension. Three things get lost:

- **Review.** If you did not understand the code well enough to write it, you do not understand it well enough to catch the bug the AI put in.
- **Ownership.** If nobody on the team can explain why a section works, changing it becomes archaeology.
- **Debugging.** Debugging needs a mental model of the system. During a production incident, "ask the AI" is not a strategy.

The test I use: if I cannot explain in plain language why the code works (what invariant it keeps, what edge case it handles, what breaks if I change one line), I do not own that code. I am renting it from the model.

And there is a long-term cost: skills you do not practice get weaker. Someone who spends years without debugging, designing a system or reading documentation on their own becomes fragile exactly when pressure is highest, such as an incident, a security audit or an architecture review. I use AI to reach understanding faster, not to skip it. "Explain this code to me" and "what could go wrong with this approach?" are among the requests I make most.

## What I learned

- AI multiplies people who know how to review. It does not replace the judgment of someone who has seen code break in production.
- Test like the customer. A clean install and interaction tests catch what slips past "it works on my machine".
- Distrust well-written text. A well-phrased error is the most dangerous kind, because it convinces.

The templates are in the ValandroUI store on Payhip, each with a live demo, and the e-books are on Amazon. All of it went through the process I described here.
