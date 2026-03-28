# Motion Pitch Pop

A simple browser-based baseball prototype for kids 7–14:
the player throws with their real arm in front of a webcam, and the game translates
that motion into a flying baseball plus particle bursts.

## What this starter does

- Uses the webcam in the browser
- Uses MediaPipe Pose Landmarker to track the body
- Detects a simple throwing gesture
- Launches a baseball on the field based on throw power
- Creates trail and impact particles
- Runs as a plain static site

## Files

- `index.html` — structure
- `style.css` — styling
- `app.js` — pose setup, throw detection, game rendering

## Run locally

Because webcam access only works in secure contexts, the easiest way to test is:
- GitHub Pages
- or a local HTTPS dev server
- or `localhost` in a local dev environment

Opening `index.html` directly from your file system may not work for webcam access.

## Put it on GitHub Pages

1. Create a new GitHub repository, for example `motion-pitch-pop`
2. Upload these files to the repository root
3. Commit the files
4. Open the repo on GitHub
5. Go to **Settings** → **Pages**
6. Under **Build and deployment**, choose **Deploy from a branch**
7. Select branch `main` and folder `/(root)`
8. Save
9. Wait a minute or two
10. Your site will appear at:
   `https://YOUR-USERNAME.github.io/motion-pitch-pop/`

## Good first upgrades

- show a throwing silhouette guide
- add left/right arm auto-detection
- add sound effects
- add branded BXCM field art
- add home run zones
- add a best-score leaderboard
- add a countdown and attract screen

## Tuning

In `app.js`, these are the first values to tweak:

- `THROW.cooldownMs`
- `forwardSpeed > 0.55`
- `extensionGain > 0.035`
- `GAME.maxThrows`
- `launchBall()` velocity values
- `makeBurst()` particle counts

If throws are not triggering:
- stand farther back
- make sure your full upper body is visible
- use stronger lighting
- slow down and exaggerate the load position before the throw

## Important note

This is a forgiving museum-style gesture detector, not true sports biomechanics.
That is intentional so kids can succeed quickly.
