import { Catalog } from "@copilotkit/a2ui-renderer";
import type { ReactComponentImplementation } from "@copilotkit/a2ui-renderer";
import { ReactStarRating } from "./ReactStarRating";
import { ReactFlightCard } from "./ReactFlightCard";
import { ReactHotelCard } from "./ReactHotelCard";
import { ReactRow } from "./ReactRow";

export const CUSTOM_CATALOG_ID = "https://a2ui.org/demos/dojo/custom_catalog.json";

export const customCatalog = new Catalog<ReactComponentImplementation>(
  CUSTOM_CATALOG_ID,
  [ReactRow, ReactFlightCard, ReactHotelCard, ReactStarRating],
  [],
);
