import { setProjectAnnotations } from 'storybook/internal/preview-api';

// @ts-expect-error - virtual module provided by storybook-project-annotations-plugin
import { getProjectAnnotations } from 'virtual:/@storybook/builder-vite/project-annotations.js';

globalThis.__STORYBOOK_ADDON_VITEST_PROJECT_ANNOTATIONS_APPLIED__ = false;

setProjectAnnotations(getProjectAnnotations());

// Later user calls would replace these annotations, so `setProjectAnnotations` refuses them from now on.
globalThis.__STORYBOOK_ADDON_VITEST_PROJECT_ANNOTATIONS_APPLIED__ = true;
