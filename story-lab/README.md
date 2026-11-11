# Story Lab

A way to see how well a model writes JRPG stories, from premise down to
dialogue, and to read different models' attempts next to each other.

There is no API and no harness. A run is a model in a Claude Code session
following `INSTRUCTIONS.md` and writing files into `runs/<run-id>/`.

## Running a new model

1. Start a session on the model you want to try, on a new branch.
2. Say: **"Follow `story-lab/INSTRUCTIONS.md`. Run label: `<name-you-choose>`."**
3. When it finishes, merge the branch. Each run lives in its own directory, so
   runs never conflict.

To go deeper on something you liked: **"In run `<label>`, expand `p07`"** (or
`p03/s1/a2`, and so on).

## Reading the runs

```sh
node story-lab/build.mjs      # checks every run, writes story-lab/viewer.html
```

Open `story-lab/viewer.html` in a browser. It is one self-contained file.

- Pick a run along the top, then click down: premise, storyline, arc, scene.
- A blue tag marks what the model itself chose to expand, with its reason.
- Star anything and leave a note. Notes are kept in your browser; **Copy my
  notes** gives you all of them as text.
- With two or more runs, **Side by side** lines up every run's premises.

## What is here

```
INSTRUCTIONS.md        the brief every model follows. Bump its version if you change it
build.mjs              validator + bundler, no dependencies
viewer.template.html   the viewer; build.mjs injects the runs into it
runs/<run-id>/         one directory per run
```

`viewer.html` is generated and not committed.

## Keeping it fair

- Every model gets the same brief. If you edit `INSTRUCTIONS.md`, bump
  `Brief version`; the viewer shows which version a run was written against.
- The brief tells the model not to read other runs. It cannot be enforced, so
  for a strict comparison start the branch from a commit with `runs/` empty.
- The model does not record its own name. You choose the label.
