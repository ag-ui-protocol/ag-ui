import { Catalog, basicCatalog } from "@copilotkit/a2ui-renderer";
import type { ReactComponentImplementation } from "@copilotkit/a2ui-renderer";
import { ReactStarRating } from "./ReactStarRating";

export const CUSTOM_CATALOG_ID = "https://a2ui.org/demos/dojo/custom_catalog.json";

export const customCatalog = new Catalog<ReactComponentImplementation>(
  CUSTOM_CATALOG_ID,
  [
    ...Array.from(basicCatalog.components.values()),
    ReactStarRating,
  ],
  Array.from(basicCatalog.functions.values()),
);
