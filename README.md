# XPOSE_retreat_quiz
code for the pub quiz during the XPose DTU retreat in November 2027

## How it works

A live pub quiz in the browser. Players need no app and no account.

- **Teams:** one phone per team opens the site (scan the QR code on the big screen), types a team name and answers each question.
- **Host:** open the site with `#host` at the end of the address on the laptop connected to the projector. The host screen has two tabs:
  - **Run the quiz:** lobby with QR code, questions, closing answers, end-of-round marking, answer reveal and scoreboard.
  - **Questions:** add and edit rounds, questions, accepted answers (separate alternatives with `|`) and pictures.

Questions, answers and pictures are saved only in the host laptop's browser, never in this repository, so nobody can peek. Use **Download backup** / **Load a backup** on the Questions tab to move them between computers.

Live sync between phones and the host uses Supabase Realtime (broadcast and presence). The project URL and publishable key at the top of `index.html` are public by design.

## Files

- `index.html`: the quiz page (host and team views).
- `adapter.js`: live sync (Supabase), local saving and picture storage.
