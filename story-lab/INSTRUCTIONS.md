# Story Lab: the brief

Brief version: 1

You are being asked to show how well you can invent a JRPG's story, from the
premise down to spoken lines. A person will read everything you write, next to
what other models wrote from this same brief. There is no score. They are
looking for work they would want to build a game on.

Read this whole file before writing anything.

## Rules of the run

1. **Write it yourself, in this session.** No subagents, no scripts that
   generate text, no web search for ideas. The run measures one author.
2. **Do not open anything under `story-lab/runs/` except your own run.** Other
   runs are other models' answers to this brief. Reading them spoils yours.
3. **Do not change this file, `build.mjs` or the viewer** as part of a run. If
   the brief is unclear, make a choice and record it in `run.json` → `notes`.
4. **Run id.** Use the label the user gave you (for example `opus-5-5`). If
   they gave none, use the next free `run-NN`. Do not put your own model name
   in the files; the user labels the run.
5. Work top-down, one step at a time, and write each file before starting the
   next step. Do not go back and revise an earlier level after seeing how the
   later ones turned out; the reader wants to see what each level was built on.

## What kind of game

A story-led, party-based JRPG that a small team could build: roughly 15 to 25
hours, a party of three to five, towns, dungeons and a world to cross, battles
(turn-based or action), and scenes carried by dialogue boxes. Any setting, any
tone.

The story has to work **as a game**. At every level, be able to say what the
player is doing with their hands, and why this could not simply be a novel.
The best premises have one system that carries the theme, so that playing the
game is the same thing as arguing about what it means.

A premise that could be the back of the box for a hundred games has failed.
So has a set of ten that are the same idea in ten costumes: vary setting, tone,
scale of stakes and the kind of person the player is.

## The shape

```
10 premises                      alternatives, written as one set
  └─ pick 3 ──► world            one per premise: cast and places
                3 storylines     alternatives: three different games this premise could be
                  └─ pick 1 ──► 5-7 arcs      in order: the chapters of that storyline
                                  └─ pick 1 ──► 6-9 scenes   in order: that arc, beat by beat
                                                  └─ pick 2 ──► dialogue   the scene as played
```

Premises and storylines are **alternatives**. Arcs and scenes are **parts in
sequence**. Each pick needs one or two sentences saying why you chose it; your
taste in choosing is part of what is being read.

If the user named which nodes to expand, expand those instead of picking.

## Files

Everything goes under `story-lab/runs/<run-id>/`. Ids are fixed: `p01`..`p10`,
`s1`.., `a1`.., `sc1`...

```
run.json
premises.json
p03/world.json
p03/storylines.json
p03/s2/arcs.json
p03/s2/a4/scenes.json
p03/s2/a4/sc5.md
```

Every entry needs `id` and `title`. The other fields below are what the viewer
knows how to label. Keep each to one or two sentences; a field you cannot fill
specifically is a sign the idea is thin. You may add a field of your own if an
idea needs it.

### `run.json`

```json
{ "label": "", "date": "YYYY-MM-DD", "brief_version": 1, "notes": "" }
```

Leave `label` as the user gave it, or empty.

### Step 1: `premises.json`

```json
{
  "premises": [
    {
      "id": "p01",
      "title": "",
      "logline": "one sentence: who, what they must do, what is in the way",
      "theme": "the question the game argues about",
      "setting": "where and when, concretely",
      "tone": "",
      "player_role": "who you are and what you do minute to minute",
      "mechanic": "the one system that carries the theme",
      "hook": "the image or moment of the first hour",
      "why_game": "what the player feels here that a reader could not"
    }
  ],
  "picks": [ { "id": "p03", "why": "" } ]
}
```

Ten premises, three picks.

### Step 2: `pNN/world.json`

```json
{
  "cast": [
    {
      "id": "c1", "name": "", "role": "who they are in the story and the party",
      "want": "", "flaw": "", "voice": "how they talk, with one sample line",
      "battle": "what they do in a fight", "secret": ""
    }
  ],
  "places": [
    {
      "id": "l1", "name": "", "kind": "town | dungeon | field | hub | ...",
      "look": "what the player sees", "play": "what the player does here",
      "change": "how it is different by the end"
    }
  ]
}
```

Five to seven of each. Voices should be tellable apart with the names covered.

### Step 3: `pNN/storylines.json`

```json
{
  "storylines": [
    {
      "id": "s1", "title": "", "summary": "the whole plot in a short paragraph",
      "question": "what the player is waiting to find out",
      "antagonist": "who or what pushes back, and why they think they are right",
      "ending": "how it ends, including what varies",
      "agency": "where the player's choices change something"
    }
  ],
  "pick": { "id": "s2", "why": "" }
}
```

Three storylines that are different games on the same premise and
world, not three endings of one plot.

### Step 4: `pNN/sN/arcs.json`

```json
{
  "arcs": [
    {
      "id": "a1", "title": "", "summary": "",
      "places": "where it happens",
      "party": "who joins, leaves or changes",
      "play": "what is new for the player: system, dungeon, boss",
      "turn": "what is different, for good, when this arc ends"
    }
  ],
  "pick": { "id": "a4", "why": "" }
}
```

### Step 5: `pNN/sN/aN/scenes.json`

```json
{
  "scenes": [
    {
      "id": "sc1", "title": "",
      "type": "cutscene | talk | explore | dungeon | battle | boss | choice | camp",
      "place": "", "cast": "who is in it",
      "summary": "what happens",
      "play": "what the player does during it",
      "turn": "what has changed when it ends"
    }
  ],
  "picks": [ { "id": "sc3", "why": "" }, { "id": "sc5", "why": "" } ]
}
```

### Step 6: `pNN/sN/aN/scN.md`

The scene as the player would get it, in this plain format:

```
[Stage direction, camera, or what the player is doing. Square brackets.]

NAME: A line of speech. Speaker in capitals, then a colon.
OTHER NAME: Short lines. A dialogue box holds about two sentences.

> A choice the player can make
  NAME: What follows from it, indented two spaces.
> Another choice
  NAME: A different reply.

NAME: The scene continues for everyone here.
```

Forty to eighty lines. Write lines people would say, in the voice you gave
them in `world.json`. Leave out anything a player would skip.

## Finishing

```sh
node story-lab/build.mjs
```

It checks every run and writes `story-lab/viewer.html`. Fix anything it
reports under your run, then commit the run directory and push. Tell the user
the run is ready and show them the viewer.

## Expanding later

The user may ask for more, for example "expand p07" or "expand p03/s1/a2".
Fill in the missing levels below that node by the same rules: a premise gets a
world and three storylines; a storyline gets arcs; an arc gets scenes; a scene
gets dialogue. Stop one level down unless asked to go further, and rebuild.
