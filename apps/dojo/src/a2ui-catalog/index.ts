import { Catalog } from "@copilotkit/a2ui-renderer";
import type { ReactComponentImplementation } from "@copilotkit/a2ui-renderer";
import {
  Row,
  FlightCard,
  HotelCard,
  ProductCard,
  TeamMemberCard,
  StarRating,
} from "./renderers";

/** Fixed schema catalog — flights, hotels + StarRating */
export const fixedSchemaCatalog = new Catalog<ReactComponentImplementation>(
  "https://a2ui.org/demos/dojo/fixed_catalog.json",
  [Row, FlightCard, HotelCard, StarRating],
  [],
);

/** Dynamic schema catalog — hotels, products, team members */
export const dynamicSchemaCatalog = new Catalog<ReactComponentImplementation>(
  "https://a2ui.org/demos/dojo/dynamic_catalog.json",
  [Row, HotelCard, ProductCard, TeamMemberCard],
  [],
);
