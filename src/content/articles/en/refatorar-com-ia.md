---
title: "Refactoring with AI without breaking what works"
description: "A safe workflow for refactoring with AI assistants: characterization tests, one technique at a time, behavior checks and the habits of generated code."
slug: "refatorar-com-ia"
theme: "ia"
order: 1
cover: ""
replaces: ["refactoring-with-ai", "clean-code-with-ai", "solid-with-ai", "design-patterns-with-ai"]
---

Refactoring has a precise definition: changing the internal structure of code without changing its external behavior. It is not rewriting, not adding features, not fixing bugs. It is making the next change cheaper without breaking what works today.

AI assistants change this discipline in two ways. They find code smells faster and more consistently than a manual read, and they apply well-known techniques (Extract Method, Introduce Parameter Object, Replace Conditional with Polymorphism) in seconds. The risk is just as real: the model can change behavior while claiming it preserved it. The discipline is in knowing how to use them safely.

## The contract: structure only

The most useful sentence I put in a refactoring request is this one:

```text
This is a structural refactoring. Do not fix bugs, improve algorithms, add
error handling or change behavior, even if you see an opportunity. If you
find something that looks like a bug, list it separately at the end.
```

Without it, the model tends to "take advantage" of the refactoring to fix whatever looks wrong. Sometimes the "bug" is behavior someone depends on, and the fix disappears inside a structural diff nobody can review properly. A bug you find becomes another ticket and another commit.

## The safe workflow

Refactoring without tests is not refactoring, it is gambling. The sequence I follow:

1. **Lock behavior with tests.** If the code has no tests, the first step is writing characterization tests.
2. **One technique at a time.** No "improve this code". Ask for "apply Extract Method to this function". Mixing several refactorings in one step makes it impossible to know which one caused a problem.
3. **Run the tests after every step.** Green, commit. Red, revert and understand before moving on.
4. **Check the claim that nothing changed.** Before accepting, ask the model to compare both versions (the prompt is below).

### Characterization tests

They document what the code *does*, not what it should do. The idea comes from Michael Feathers' *Working Effectively with Legacy Code*, and it pairs very well with AI, because writing this kind of test is mechanical, extensive work.

```text
Write characterization tests for this function. The goal is NOT to prove the
behavior is correct, but to lock the current behavior so that any refactoring
that changes the output gets caught.
- Name each test by WHAT the function returns for WHICH input.
- Cover typical inputs, boundaries, empty/null and error conditions.
- Fix nothing: test it as it is, even if it looks wrong.
At the end, list behaviors that look suspicious so I can decide separately
whether they are bugs.
```

The list of suspicious behaviors at the end is often the most valuable part of the session.

### An inventory before any change

Before applying any technique, ask for a prioritized inventory:

```text
Audit this code for refactoring opportunities. For each smell: its name (Long
Method, Feature Envy, Data Clump...), the affected sections, the technique that
fixes it, and its impact on readability and changeability (low/medium/high).
Sort by impact. Do not generate the refactored code yet.
```

The "do not generate it yet" is deliberate. If the model hands you code right away, you skip deciding whether each change is worth its cost. The prioritization is yours.

## The techniques I use most

### Extract Method

The most frequent technique. The trigger is a block inside a function that could be described by a name different from the function's name. Comments like `// fetch the user` and `// compute the summary` are direct hints: each is an extraction waiting for a name.

```typescript
// after extraction: the main function becomes an index of what happens
function generateMonthlyReport(userId: string, month: number, year: number): MonthlyReport {
  const user = findUserOrThrow(userId);
  const period = monthRange(month, year);
  const transactions = findTransactions(userId, period);
  return toReport(user, { month, year }, summarize(transactions), transactions);
}

function summarize(transactions: Transaction[]): Summary {
  const sum = (type: TransactionType) =>
    transactions.filter(t => t.type === type).reduce((acc, t) => acc + t.amount, 0);
  const totalIn = sum('credit');
  const totalOut = sum('debit');
  return { totalIn, totalOut, balance: totalIn - totalOut };
}
```

Ask for names that describe intent rather than repeat the comment.

### Introduce Parameter Object

When the same three or four parameters show up together in several signatures (`origin, destination, departure, return`), they are an unnamed concept. The new object should validate its own invariants:

```typescript
class FlightRoute {
  constructor(
    readonly origin: string,
    readonly destination: string,
    readonly departure: Date,
    readonly returnDate?: Date,
  ) {
    if (!origin || !destination) throw new Error('Origin and destination are required');
    if (returnDate && returnDate < departure) throw new Error('Return must be after departure');
  }

  get isRoundTrip(): boolean {
    return this.returnDate !== undefined;
  }
}

// signatures now take the concept instead of four loose values
declare function searchFlights(route: FlightRoute): Promise<Flight[]>;
declare function bookFlight(route: FlightRoute, passengerId: string): Promise<Booking>;
```

Note that the validation in the constructor is new behavior. If the old functions did not validate, that is a change and deserves its own commit.

### Replace Conditional with Polymorphism, without breaking the API

When the same `switch` on a type appears in several methods, the type should carry the behavior.

```typescript
type ShippingType = 'standard' | 'express' | 'overnight';
interface Order { shippingType: ShippingType; weight: number; }

// before: the same switch in three methods
export class Shipping {
  calculateCost(order: Order): number {
    switch (order.shippingType) {
      case 'standard': return order.weight * 2.5;
      case 'express': return order.weight * 5.0 + 10;
      case 'overnight': return order.weight * 8.0 + 25;
    }
  }
  estimateDeliveryDays(order: Order): number {
    switch (order.shippingType) {
      case 'standard': return 7;
      case 'express': return 3;
      case 'overnight': return 1;
    }
  }
  getCarrierCode(order: Order): string {
    switch (order.shippingType) {
      case 'standard': return 'STD-01';
      case 'express': return 'EXP-02';
      case 'overnight': return 'OVN-03';
    }
  }
}
```

A common mistake, AI answers included, is to use the opportunity to change the API: callers now have to write `Shipping.for(type).calculateCost(...)`. That is no longer a refactoring; it is an interface change that forces every caller to change. The version that preserves the contract keeps the three public methods with the same signatures and only moves what is inside them:

```typescript
interface ShippingRule {
  cost(order: Order): number;
  deliveryDays: number;
  carrierCode: string;
}

const RULES: Record<ShippingType, ShippingRule> = {
  standard: { cost: o => o.weight * 2.5, deliveryDays: 7, carrierCode: 'STD-01' },
  express: { cost: o => o.weight * 5.0 + 10, deliveryDays: 3, carrierCode: 'EXP-02' },
  overnight: { cost: o => o.weight * 8.0 + 25, deliveryDays: 1, carrierCode: 'OVN-03' },
};

// after: same class, same methods, same signatures
export class Shipping {
  calculateCost(order: Order): number {
    return RULES[order.shippingType].cost(order);
  }
  estimateDeliveryDays(order: Order): number {
    return RULES[order.shippingType].deliveryDays;
  }
  getCarrierCode(order: Order): string {
    return RULES[order.shippingType].carrierCode;
  }
}
```

Callers do not change, the characterization tests stay valid, and a new shipping type is one new entry in the map (the `Record` makes the compiler demand the entry once the type is added to the union). If exposing `ShippingRule` directly makes sense later, that is a second step, with the API change spelled out in the commit.

This example also shows why the behavior check matters. If `shippingType` comes from external JSON with an unexpected value, the original `switch` returns `undefined`, while the new version throws a `TypeError` when it reads `RULES[...]`. The difference only shows up at runtime, and only someone looking for it will find it.

### Move Method and Extract Class

A method that only uses another class's data (feature envy) moves to the class that owns the data. A class whose fields and methods form two groups that never talk to each other (identity and address in a `User`, say) becomes two, joined by composition. These are refactorings AI gets right most of the time, because the criterion is visible in the code itself.

## The behavior check

After every generated refactoring, before accepting it:

```text
Compare the original and refactored versions and list every case where they
might behave differently:
1. Return values: are all paths equivalent?
2. Exceptions: does the new one throw where the original did not, or swallow
   what the original propagated?
3. Side effects: anything written, logged or emitted differently?
4. Null and missing values: does either handle absence differently?
5. Short-circuiting: does any extraction change when evaluation stops?
6. Mutation: is any object now mutated in place (or no longer mutated)?
For each difference, say whether it is intentional.
```

It catches most silent changes, but it does not replace the tests. It is a second reading, not a proof.

## The habits of AI-written code

Refactoring with AI also means refactoring *what the AI wrote*. Some patterns show up often enough that it pays to look for them actively:

- **The do-everything function.** If the request describes five responsibilities, the model delivers one function with five responsibilities. It did what it was asked. Split the request before sending it.
- **Over-defensiveness.** Null and type checks on internal parameters that already arrived validated, and `try/catch` blocks that swap a specific exception for a generic one. Validate at the system boundary and trust the contract inside.
- **Magic numbers.** `>= 3` and `* 0.95` scattered around. Ask for thresholds and rates to be extracted as named constants.
- **Off-style code.** The model does not know the team's conventions. Paste an existing snippet into the request ("follow this pattern") and the output improves a lot.
- **Over-extraction.** A three-line block becomes a function, two steps become two functions, and following the flow means jumping across ten places. Extract when the new name adds information, not just because the block is separable.
- **Premature abstraction.** Strategy, factory and registry for a case with two variants that will never have a third. This one deserves its own section.

## Dependency inversion without overdoing it

DIP says high-level modules should not depend on low-level modules; both depend on abstractions. In practice, an `OrderService` that does `new PostgresOrderRepository()` in its constructor ties business rules to the database: changing the database means touching the rules, and testing the rules needs a database. Injecting the dependency through the constructor, typed by an interface the service itself defines, solves both.

The opposite excess is an interface for everything, and AI does a lot of that when you ask it to "follow SOLID". An interface has a cost: another file, another indirection. It pays off when there are two implementations (production plus a test fake already counts) or when you want to shield a stable module from a volatile detail, like a third-party payment gateway. An interface with a single implementation and no test using another one is ceremony.

## The pattern test

Before accepting a design pattern suggested by AI, ask one question: **what concrete, likely change does this pattern make easier?**

If the answer is "none I can think of today", the pattern is adding indirection without flexibility. A Strategy with one strategy, an Observer between two methods of the same class, a Facade over two internal calls: all of them make today's code harder to read in exchange for flexibility that may never be used. If the change is likely (a third payment method is already on the roadmap), the pattern pays for itself. Three similar lines are better than the wrong abstraction.

## A sequence for legacy code

For the 500-line class with no tests and no clear owner:

1. **Understand before touching.** Ask for a section-by-section explanation, with inputs, outputs, side effects and external dependencies, and no suggestions.
2. **Characterization tests** for what you understood.
3. **Rename first.** Good names cost nothing and clarify everything else.
4. **Extract Method** on the comment-marked blocks.
5. **Extract Class** once the groupings become visible.
6. **Polymorphism last.** It is the deepest structural change and only becomes clear once everything else is well named and extracted.

There is an effect that compounds in your favor: well-structured code gets better suggestions. The model reasons far better about a short, well-named function than about a tangled two-hundred-line block. Each refactoring session leaves the code easier for the next one, with or without AI.

What the tool does not replace is judgment about when to abstract and when to keep things inline, when the third repetition justifies a shared function and when it is coincidence, when a name is wrong because the business concept changed. Use AI to remove the mechanical friction (names, extractions, tests, consistency) and spend the time saved on those decisions.
