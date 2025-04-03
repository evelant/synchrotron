# Changesets

This directory contains changesets, which are used to generate the changelog and manage version bumps.

## What are changesets?

Changesets are a way to manage versioning and changelogs for your project. They allow you to:

1. Record changes to your package in a structured way
2. Automatically generate changelogs
3. Manage version bumps based on the types of changes

## How to use changesets

When making changes to the codebase that should be reflected in the changelog, you should create a changeset:

```bash
bun changeset
```

This will prompt you to:
1. Select the type of change (patch, minor, major)
2. Write a description of the change

A new markdown file will be created in the `.changeset` directory. This file should be committed along with your code changes.

## When to use changesets

You should create a changeset when:

- Adding new features
- Fixing bugs
- Making breaking changes
- Making significant improvements or changes to documentation

You don't need to create a changeset for:

- Minor code refactoring
- Changes to tests
- Changes to internal tooling that don't affect users

## How versioning works

When a PR with changesets is merged to the main branch:

1. The GitHub Actions workflow will create a PR that applies the changesets
2. When that PR is merged, the packages will be published with the new version

For more information, see [the Changesets documentation](https://github.com/changesets/changesets).
