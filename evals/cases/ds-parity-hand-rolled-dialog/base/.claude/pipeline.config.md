# Pipeline config — fleet-console
## Project
- slug: fleet-console
- stack: React 18 / TS, npm workspaces
- package_manager: npm
- main_branch: main
## Task state
- task_path: tasks/
## Commands
- lint: —
- type_check: —
## Design sources of truth
- ui_lib: @fleet/ui, no prefix, components in `packages/ui/src/` (a workspace package of this repo)
## Code layout
- components: apps/console/src/components/
- page_components: apps/console/src/pages/
