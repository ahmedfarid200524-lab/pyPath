# Brief for course writers

You are writing part of a beginner coding course for **pyPath**, a Duolingo-style learning app (map of levels, hearts, XP). The existing Python course is the model for tone and quality. New courses: JavaScript, C++, C#, HTML. Learners are complete beginners, mostly teenagers and adults, many non-native English speakers: short sentences, no jargon without explanation, friendly, never condescending.

## Read first
1. `content/SCHEMA.md` — the exact JSON format and the rules the checker enforces. Follow it literally.
2. Reference of the Python course for style (read both):
   - `/tmp/claude-0/-home-claude/546af21b-8b1c-56fe-aae6-1afe1bab9bac/scratchpad/py-unit2-lessons-and-hand.json` — lessons and `hand` questions of Python unit 2
   - `/tmp/claude-0/-home-claude/546af21b-8b1c-56fe-aae6-1afe1bab9bac/scratchpad/py-x-unit2.json` — its `hard` questions, bug hunts and project (note: the Python data uses slightly different field names for order questions — `ord` — use the names in SCHEMA.md, not Python's)

## What to produce
One JSON file per unit you are assigned, at `content/<course id>/uNN.json` (the manifest `content/<course id>/course.json` already exists — do not edit it). Each unit has: 2-3 lessons (3-5 pages each), 14 `hand` questions, 10 `hard` questions, 2 bug hunts x 3 items, 1 project. Depth target per unit: a real beginner who completes it can do the project without help.

Strict requirements:
- Files must be **valid JSON** (no comments, no trailing commas). Write real newlines as `\n` inside strings. Prefer writing the unit with a small Node or Python script (`json.dump` / `JSON.stringify`) from native data structures so quoting can never break; keep the generator script in the scratchpad directory, not in the repo.
- Run `node scripts/check-content.js content/<id>/uNN.json` after each unit, fix every ERROR, and read every WARN. The checker really executes JavaScript and compiles C++ (g++ -std=c++17). It cannot compile C#, so for `cs` you must verify every program and every `out` answer by careful hand-tracing — twice.
- Questions must test understanding, not memory of trivia. Distractors must be plausible beginner mistakes. Vary the position of the right answer's length and wording. Every `why` must teach.
- Each unit builds on the previous units only. Do not use anything taught later than the unit you are writing (except where a unit explicitly introduces a tiny piece of it so the project makes sense — see SCHEMA).
- Unit difficulty ramps up across the course. `hard` questions should make a good student pause: trace a loop, spot a subtle off-by-one, combine two ideas, predict a surprising-but-fair result. Never ask about undefined behaviour, implementation-defined output, or things the unit did not teach.
- Facts must be right. If you are not 100% sure a statement about the language is true, rewrite it. Use current best practice (e.g. `const`/`let`, `===`, modern C++ `std::vector`, C# string interpolation).
- No copyrighted text. No offensive examples. Names in examples: diverse and friendly.
- Do not modify any file other than your own unit files. Do not run `npm install`, do not use the network, do not touch git.

## When you finish
Reply with 5-8 lines only: files written, final checker result (errors/warnings count), anything you could not verify and why. Do not paste content back.
