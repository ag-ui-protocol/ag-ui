import { Catalog } from "@copilotkit/a2ui-renderer";
import type { ReactComponentImplementation } from "@copilotkit/a2ui-renderer";
import { Row, HotelCard, ProductCard, TeamMemberCard } from "./renderers";

export const DYNAMIC_CATALOG_ID = "https://a2ui.org/demos/dojo/dynamic_catalog.json";

export const dynamicCatalog = new Catalog<ReactComponentImplementation>(
  DYNAMIC_CATALOG_ID,
  [Row, HotelCard, ProductCard, TeamMemberCard],
  [],
);
