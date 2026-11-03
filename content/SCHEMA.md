# pyPath course content format

Every course lives in `content/<id>/`:

```
content/js/course.json     the manifest
content/js/u01.json        one file per unit, listed in course.json "units"
content/js/u02.json  ...
```

`course.json`:

```json
{ "id": "js", "t": "JavaScript", "e": "🟨", "d": "From console.log to async code", "lang": "js",
  "units": ["u01", "u02", "u03"] }
```

`lang` is `js`, `cpp`, `cs` or `html`. The app loads the manifest, then every unit file.

## A unit file

```json
{
  "t": "Hello, JavaScript",          // unit title (short)
  "e": "👋",                          // one emoji
  "lessons": [ LESSON, LESSON ],      // 2 or 3 lessons, 3-5 pages each
  "hand":  [ QUESTION x 14 ],         // exactly 14: practice 1 = first 7, practice 2 = last 7, unit test = 12 random of the 14
  "hard":  [ QUESTION x 10 ],         // exactly 10, noticeably harder than "hand"; the learner has only 3 hearts
  "bugs":  [ {"title":"Bug hunt 1","items":[BUG x 3]}, {"title":"Bug hunt 2","items":[BUG x 3]} ],
  "project": PROJECT
}
```

A learner passes a unit only after the lessons, both practices, the unit test, the hard level and the project. (Bug hunts are optional bonus levels.)
So the **project must be doable using only what this unit and earlier units taught**.

### LESSON

```json
{ "t": "What is JavaScript?",
  "pages": [
    { "h": "Heading of the page",
      "p": "Paragraph text. Blank line (\\n\\n) starts a new paragraph. Use «code» for inline code and **bold**.",
      "c": "optional code block shown under the text",
      "o": "optional output block shown under the code (exactly what the code prints)",
      "tip": "optional one-line tip, shown in a yellow box" }
  ] }
```

Pages are short (under ~120 words of text, code under 14 lines). Teach one idea per page, start from zero, explain every new word the first time it appears, and use friendly second-person ("you") English for beginners aged 12+.
A page that has `o` must have `c`, and `o` must be exactly what running `c` produces.

### QUESTION (used in `hand` and `hard`)

All four types have a required `why` (1-2 sentences shown after answering, explaining the right answer, never "because it is correct").

```json
{ "type": "out",   "code": "console.log(1 + 2)", "answer": "3", "wrong": ["12", "1 + 2", "undefined"], "why": "..." }
```
"What does this print?" Exactly 3 wrong answers. `answer` must be exactly the program's output (multi-line output uses \n).

```json
{ "type": "mc", "q": "Which keyword makes a constant?", "code": null, "ans": "const", "wrong": ["let", "var", "fixed"], "why": "..." }
```
Multiple choice. `code` is optional (shown under the question). Exactly 3 wrong answers.

```json
{ "type": "fill", "q": "Complete the loop header.", "code": "for (let i = 0; i < 3; ___) {\n  console.log(i);\n}", "ans": ["i++", "i += 1", "++i"], "why": "..." }
```
Exactly one `___` blank. `ans` lists every accepted answer; the app ignores spaces and treats ' like ". Every accepted answer must work and give the same result. Keep answers short (a keyword, a name, an operator or one short expression).

```json
{ "type": "order", "q": "Put the lines in order.", "lines": ["let n = 3;", "n = n + 1;", "console.log(n);"], "why": "..." }
```
3-8 distinct lines, each under 60 characters; `lines` is the correct order, the app shuffles them.

Rules for good questions:
- Wrong answers must be plausible mistakes a beginner really makes, about as long and detailed as the right one. The right answer must not be systematically the longest or most specific.
- Never write "all of the above" / "none of the above".
- Options are at most 90 characters.
- Mix the types: each unit's `hand` needs at least 2 `fill` and 1 `order`; every `hand` and `hard` list should have several `out`.
- No trick questions on undefined behaviour or things the unit has not taught. `hard` questions may combine ideas from this and earlier units, trace longer code, or find the subtle mistake.
- Do not repeat a question inside a course unit.

### BUG (3 per hunt)

The learner taps the one line with the bug.

```json
{ "code": "let total = 0;\nfor (let i = 1; i <= 3; i++) {\n  total = i;\n}\nconsole.log(total);",
  "fixed": "let total = 0;\nfor (let i = 1; i <= 3; i++) {\n  total += i;\n}\nconsole.log(total);",
  "line": 2,
  "symptom": "It prints 3 but the total should be 6.",
  "why": "total = i replaces the total each time; += adds to it." }
```
- `line` is the 0-based index of the buggy line. `code` and `fixed` have the **same number of lines and differ on exactly that one line**.
- Code is a complete, short program (3-10 lines).
- The bug must really change behaviour (an error, or a different output). The checker runs both versions.
- `symptom` says what the learner would see (error message, wrong output) without naming the line.

### PROJECT

Depends on `lang`:

**js** (checked in the browser by calling a function)
```json
{ "title": "Tip Calculator", "brief": "Write a function ... Explain what to build, the function name, arguments, what to return, with 1-2 examples. Use «code» for names.",
  "fn": "tip",
  "starter": "function tip(bill, percent) {\n  // your code here\n}\n",
  "solution": "function tip(bill, percent) {\n  return Math.round(bill * percent) / 100;\n}\n",
  "tests": [ { "label": "tip(50, 10)", "args": [50, 10], "want": 5 }, ... 4-6 tests ] }
```
`args` and `want` are JSON values. Include edge cases. The starter must fail the tests. `solution` must pass all of them.

**html** (the learner edits a page and sees a live preview; checks run on the rendered page)
```json
{ "title": "My Profile Card", "brief": "...", "starter": "<!doctype html>...<!-- TODO -->...", "solution": "<!doctype html>...",
  "tests": [ { "label": "Has an h1 with text", "expr": "document.querySelector('h1') && document.querySelector('h1').textContent.trim().length > 0" }, ... 5-8 tests ] }
```
`expr` is a JavaScript expression using `document`; it must be truthy for a correct page. Scripts in the page do not run. Use `getComputedStyle` only if the unit teaches inline styles (jsdom supports inline `style` attributes and `<style>` rules for simple selectors).

**cpp** and **cs** (no compiler in the browser, so the app checks that the program has the required building blocks and shows a reference solution when the learner passes)
```json
{ "title": "Temperature Table", "brief": "...", "starter": "#include <iostream>\nusing namespace std;\nint main() {\n  // TODO\n}\n", "solution": "...",
  "samples": [ { "stdin": "", "out": "0 C = 32 F\n10 C = 50 F\n" } ],
  "tests": [ { "label": "Uses a for loop", "must": ["\\bfor\\s*\\("] }, { "label": "Prints with cout", "must": ["cout\\s*<<"], "mustNot": ["printf"] }, ... 5-7 tests ] }
```
- `must`: regular expressions that must ALL match the learner's code; `mustNot`: none may match. The learner's code is first stripped of comments and has all whitespace collapsed to single spaces, so write patterns with `\\s*` between tokens.
- Check for the *building blocks* the brief asks for (a loop, a function with a given name and signature, `cin >>`, a `switch`, ...), not for exact formatting. Be generous: accept reasonable alternatives (`for` or `while`, `i++` or `i += 1`).
- Do not require things only the solution happens to do. The checks must pass for the reference solution and fail for the starter.
- `samples` describe what the finished program prints for the given input; the checker compiles `solution` with g++ (cpp) and compares. In C# the checker can only check syntax, so trace `samples` very carefully by hand.
- The brief must say exactly what the program has to read and print, with the sample run shown.

## Language style by course

- **js** — plain modern JavaScript (ES2020) running in a worker: no DOM, no `alert`/`prompt`/`require`. Output only with `console.log`. Printing objects/arrays: `console.log` of an array or object prints JSON in this app (`[1,2,3]`, `{"a":1}`, with no spaces), so prefer `JSON.stringify(...)` or `.join(",")` in questions to stay unambiguous. Async code (`setTimeout`, promises, `await`) works; the runner waits for timers (max 1.5s each).
- **cpp** — C++17, compiled with `g++ -std=c++17`. Beginner programs use `#include <iostream>` + `using namespace std;`. Complete programs with `main()` are best for `out` questions; fragments without `main` are accepted by the checker (it wraps them in `main`). `out` programs must have deterministic output (no uninitialised variables, no pointer addresses, no undefined behaviour, no unspecified order of evaluation).
- **cs** — C# 12 / .NET 8. Use top-level statements for short snippets (`Console.WriteLine("Hi");`) and explain the classic `class Program { static void Main() { } }` once. Because nothing here can compile C#, **be extra careful**: every snippet must be valid C#, every `out` answer traced by hand twice, avoid culture-dependent formatting (decimal separators, date formats), avoid anything platform specific.
- **html** — HTML5 and a little CSS (inline `style`, then `<style>` with simple selectors). No JavaScript in pages. `out` is rarely useful for HTML; prefer `mc`, `fill`, `order`. For bug hunts, the buggy markup should fail HTML validation (unclosed tag, wrong nesting, wrong attribute, missing alt...) — if the bug is valid HTML but wrong (e.g. wrong tag for the job), set `"semantic": true` on the item. For lesson pages that deliberately show broken HTML set `"invalid": true`.

## Optional escape hatch

Any lesson page, question or bug item may carry `"noexec": true` to tell the checker not to execute it (use only when it truly cannot be run, e.g. a page that shows browser-only behaviour). Every use is counted and reviewed. Do not use it to avoid a failing check.

## Checking your work

```
node scripts/check-content.js content/<id>/u03.json      # one unit
node scripts/check-content.js content/<id>              # the whole course
```
Fix every `ERROR`. Read every `WARN` and fix it unless it is clearly a false alarm. Then re-read your own questions once more: is the marked answer really the only correct one? Does `why` explain it?
