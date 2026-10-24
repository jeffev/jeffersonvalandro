---
title: "Code quality in practice, and what I learned building archlens-ai"
description: "The anti-patterns that degrade code the most, cycles, complexity, Fowler's technical debt quadrant, and a case study of my own tool, archlens-ai."
slug: "qualidade-de-codigo-archlens"
theme: "qualidade"
order: 2
cover: "images/archlens.png"
replaces: ["code-quality"]
---

Every team says it cares about code quality, and few can measure it. Ask five people what "good code" means and you get five answers: formatting, coverage, naming, complexity. All right, all incomplete.

What interests me is structural decay, because it is invisible until it isn't. Nobody breaks a system in one commit. It gets worse through decisions that each looked reasonable: one more method on the class that already does everything, an import that closes a cycle, a constant duplicated "just this once". Six months later, a simple change takes three people to understand its impact.

Code review alone does not catch this. A reviewer sees a diff, not the trend the diff belongs to. That realization is what led me to build [archlens-ai](https://jeffev.github.io/archlens-ai), a command-line tool that analyzes a project's architecture and produces a report. The second half of this piece is an honest case study of it, including where it falls short.

## The six anti-patterns that cost the most

Most of the names come from the code smell catalog in Martin Fowler's *Refactoring*. Naming matters: in a review, "this is feature envy" is faster and less personal than a paragraph of explanation.

**God class.** The class that knows and does too much. It grows because it already exists, already has the repository injected, already imports what it needs. The typical sign is an `OrderService` that creates orders, sends emails, generates invoice PDFs, updates stock and calculates shipping. The fix is to split by reason to change: email, invoices, stock and shipping change for different reasons and deserve different homes.

**Feature envy.** A method more interested in another class's data than its own.

```java
// lives in ReportService, but the calculation belongs to Order
BigDecimal total(Order order) {
    BigDecimal subtotal = order.getItems().stream()
            .map(i -> i.getPrice().multiply(BigDecimal.valueOf(i.getQuantity())))
            .reduce(BigDecimal.ZERO, BigDecimal::add);
    BigDecimal discount = order.getCoupon() == null ? BigDecimal.ZERO : order.getCoupon().getRate();
    return subtotal.multiply(BigDecimal.ONE.subtract(discount));
}
```

A chain of getters on another object is the giveaway. It is often a symptom of an anemic model: data in classes with only getters and setters, behavior scattered across services. Moving the method into `Order` lowers coupling and raises cohesion in one move.

**Shotgun surgery.** The opposite of a god class: one logical change means touching many files. Adding "phone" to a customer touches the entity, DTO, mapper, validator, OpenAPI contract, form and email template. No file is large; the concept is scattered. The fix is to pick a single source of truth and derive the rest from it, for example generating DTOs and validation from the OpenAPI contract.

**Data clump.** Data that always travels together and has not been named yet: `start, end, timeZone`; `street, city, postalCode`. In Java 21 a record solves it in one line and centralizes validation too:

```java
public record Period(LocalDate start, LocalDate end, ZoneId zone) {
    public Period {
        if (end.isBefore(start)) throw new IllegalArgumentException("end before start");
    }
}
```

**Dead code.** Unreachable branches, methods nobody calls, orphan classes. Besides taking up space, it confuses: newcomers cannot tell whether it is intentional or forgotten. The fix is deletion; that is what git history is for.

**Primitive obsession.** IDs as `String`, money as `double`, email as free text. It compiles until someone passes a product ID where a customer ID was expected. Value objects (`CustomerId`, `Money`, `Email`) turn that mistake into a compile error and push validation to the boundary.

## Dependency cycles are a category of their own

A cycle does not hurt readability or performance directly. It destroys your ability to think about modules separately: if `orders` depends on `customers` and `customers` depends on `orders`, you cannot test, understand or extract one without the other. They have become one module with two names.

And cycles are hard to see in review, because a single import looks harmless. They only show up in the graph, which nobody draws by hand. In Java, ArchUnit checks this in the build:

```java
@ArchTest
static final ArchRule noCyclesBetweenModules =
        slices().matching("com.example.(*)..").should().beFreeOfCycles();
```

The usual fix is to extract what both need into a third module, or invert one of the dependencies with an interface or an event.

## Cyclomatic complexity

It is one of the few metrics with a real number behind it. Thomas McCabe defined it as the number of linearly independent paths through a function: each `if`, `case`, loop, `&&` and `||` adds one. It tells you how many test cases you need to cover every branch and, indirectly, how hard the function is to understand. The limit of 10 per method comes from McCabe's original paper and is the default for Checkstyle's `CyclomaticComplexity` rule.

```xml
<module name="CyclomaticComplexity">
    <property name="max" value="10"/>
</module>
```

On a legacy codebase with many functions above that, start looser (15 or 20) and tighten gradually. A rule that fails in 400 places on day one gets turned off on day two.

## The technical debt quadrant, read correctly

Martin Fowler proposed classifying technical debt on two axes: **deliberate or inadvertent**, and **reckless or prudent**.

| | Reckless | Prudent |
|---|---|---|
| **Deliberate** | "We don't have time for design." | "We must ship now and deal with consequences." |
| **Inadvertent** | "What's layering?" | "Now we know how we should have done it." |

A common misreading is to use the quadrant to decide *which debt to pay off*. That is not what it is for. The quadrant describes **how the debt came about**, and what it diagnoses is the team and the process, not the code.

- **Reckless** debt (the two left-hand cells) points to a culture or knowledge problem. Paying down existing debt does not help if the process keeps producing more. The action is training, review and automated gates.
- **Prudent deliberate** debt is a legitimate business decision, as long as it is recorded and has a repayment plan.
- **Prudent inadvertent** debt is unavoidable, even for excellent teams: you only discover the right design after building it. Fowler is emphatic on this point.

Deciding to *pay* is a different conversation, and the criterion is the interest: how much that debt slows down the changes you need to make. A reckless hack in a module nobody has touched in two years costs almost nothing; prudent debt at the heart of the domain that every sprint runs into costs a lot. Prioritize by interest, not by quadrant.

## Case study: archlens-ai

[archlens-ai](https://github.com/jeffev/archlens-ai) is my own project, open source under the MIT license and published on npm. You point it at a directory and it produces a self-contained HTML report with an interactive stack graph, a module map, a 0–100 health score, per-module scores (cohesion, coupling, size), anti-patterns, cycles, test coverage per module and refactoring suggestions.

```bash
npx archlens-ai analyze ./my-project
npx archlens-ai analyze ./my-project --depth deep          # reads the contents of key files
npx archlens-ai analyze ./my-project --profile security    # OWASP Top 10 focus
```

### How it works inside

It is worth being transparent, because this defines what you can expect from it. The flow has four steps:

1. **Scan**: walks the file tree, reads configuration files (`package.json`, `docker-compose`, application configs) and, for Node.js projects, builds the import graph with madge.
2. **Macro prompt**: Claude Code receives this material and describes the stack: frameworks, databases, queues and configuration issues for each.
3. **Micro prompt**: Claude Code identifies logical modules, assigns scores, flags anti-patterns and proposes a suggested architecture, as JSON validated against a schema.
4. **Render**: the JSON becomes an HTML page with Cytoscape.js embedded. Cycle detection is a depth-first search over the dependencies between modules.

In other words: **the scores and anti-patterns are a language model's judgment**, guided by explicit criteria in the prompt (a god class as "over 300 lines with multiple concerns", lower coupling earns a higher score, and so on). They are not computed metrics like cyclomatic complexity.

### Running it on a real project

The demo report published on the project's site comes from one of my systems, Tradelink: a NestJS backend with TimescaleDB and Redis, a Python FastAPI worker for backtests and a React frontend. The result: an overall score of 44 out of 100, 12 modules identified and 7 suggested changes.

The findings that interested me most:

- **God class** in the portfolio module: the portfolio service was by far the largest in the backend and mixed positions, profit-and-loss calculation, trade aggregation and reporting. The report gave the module 20 out of 100, with cohesion at 15.
- **Dead code**: a test file for a `trades` module that had no implementation anywhere in the tree. The report raised both hypotheses: a removed feature leaving an orphaned test, or a test written for something never implemented.
- **Shotgun surgery** in backtesting: adding a parameter meant changing the NestJS entity, the service, the FastAPI route, the backtest engine and the frontend form, with no shared contract to generate the rest.
- **Coverage**: only 4 test files, covering 2 of the 12 modules, with portfolio, the riskiest, having no tests at all.

None of this is impossible to find on your own. The value was finding all of it in about a minute, named and prioritized, in a format you can put in front of a team and discuss.

### Where it is not enough

Building the tool left me with a clear sense of its limits, and I would rather say so here than let someone find out in production:

- **The score varies between runs.** Since it comes from a model, two runs on the same code can give different numbers. The trend over time is informative; a three-point difference between two runs is not.
- **The deterministic import graph only exists for Node.js.** For Java, Python, Go or Rust, the model infers dependencies from the file tree and, in `deep` mode, from the contents of key files. The cycles it reports are cycles between the modules the model identified, not between real packages.
- **Large projects are sampled.** The prompt receives a capped list of files and dependencies. In a Java monolith with thousands of classes, it sees a fraction.

That is why, although the tool has a `--min-score` option that exits with code 1 below the threshold, I would not use it as a hard merge gate. If you want it in CI, use a generous margin and publish the report as an artifact for discussion:

```yaml
- name: Architecture report
  run: npx archlens-ai analyze . --no-open --output archlens.html --min-score 50
  continue-on-error: true
- uses: actions/upload-artifact@v4
  with:
    name: archlens
    path: archlens.html
```

## How I combine the tools

What works for me is separating **gates** from **diagnosis**.

A gate must be deterministic: the same input gives the same result, every time. In Java that means Checkstyle and PMD for complexity and style, SpotBugs for bug patterns, SonarQube with a quality gate on new code, and ArchUnit for dependency rules and cycles between packages. Those break the build.

Diagnosis can be judgment: it is for seeing the whole picture, prioritizing and starting a conversation. That is where archlens-ai comes in, alongside human review. I run it when I join a project, before planning a large refactoring, and every so often to see the trend.

And the boy scout rule applies: every PR leaves the files it touched a little better than it found them. Not a full refactoring; just deleting the dead code that is right there, naming the data clump, splitting the function that went past the limit. Applied consistently, every PR becomes a small improvement instead of a neutral event.

Quality is a trend, not a snapshot. A module scoring 60 and rising is in better shape than one at 75 and falling, and the direction matters more than the number of the day.
