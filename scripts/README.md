# Build Scripts

This directory contains build scripts for the refurbminer project.

## copy-public.js
A Node.js script that copies public files from `src/public` to `dist/public`.
This is the default method used by `npm run build`.

## copy-public.sh
A shell script that does the same copying using standard Unix commands.
This is useful for Termux and other Unix-like environments.

## Usage

The build process automatically uses `copy-public.js` via the `postbuild` script.

If you encounter issues on Termux or other environments, you can try:

```bash
# Use shell script version
npm run postbuild:shell

# Use copyfiles version
npm run postbuild:copyfiles

# Use inline Node.js fallback
npm run postbuild:fallback
```

## Troubleshooting

If public files are not being copied on Termux:

1. First try: `npm run postbuild:shell`
2. If that fails: `npm run postbuild:fallback`
3. Manual copy: `cp -r src/public/* dist/public/`

Make sure the `dist` directory exists before running copy commands.
