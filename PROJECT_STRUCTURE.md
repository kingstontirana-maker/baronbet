# Project structure

The frontend runtime is unchanged in behavior. `public/index.html` now loads the same inline CSS/JS externally from `public/euro07.bet/vbet/user/build/main.css` and `main.js`.

The `euro07.bet/vbet/user/build` directory contains the same handler/module names visible in the reference DevTools tree. Those named files are organization boundaries only; they are not loaded at runtime, preventing duplicate event handlers or changed behavior.
