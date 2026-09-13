Directories that stand in for a helper, so `tools.test.ts` can see the registry
refuse one and the runner stop one. Nothing here computes anything: the real
helpers are the pinned submodule at `apps/api/tools/`, and a test that broke one
of those to see a refusal would be testing the helpers' repository.
