# bb-plugin-ayu-mirage

A focused [Ayu Mirage](https://github.com/ayu-theme/ayu-colors) theme for BB. It uses muted blue-grey surfaces, warm text, an amber primary accent, Ayu syntax colors, and Ayu's terminal palette.

## Install

From this plugin collection:

```sh
bb plugin install path:. --plugin ayu-mirage
```

Then select **Ayu Mirage** under Settings > Appearance, or run:

```sh
bb theme set plugin:ayu-mirage:ayu-mirage
```

## Development

```sh
npm install
npm run typecheck
npm run build
bb plugin install .
```

The BB token mapping comes from [`vburojevic/bb-plugin-ayu`](https://github.com/vburojevic/bb-plugin-ayu/tree/main). Ayu's colors are MIT-licensed by the Ayu project.
