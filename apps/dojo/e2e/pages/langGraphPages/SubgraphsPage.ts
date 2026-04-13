import { Page, Locator, expect } from '@playwright/test';
import { CopilotSelectors } from '../../utils/copilot-selectors';
import { sendChatMessage, awaitLLMResponseDone } from '../../utils/copilot-actions';
import { DEFAULT_WELCOME_MESSAGE } from '../../lib/constants';

export class SubgraphsPage {
  readonly page: Page;
  readonly chatInput: Locator;
  readonly sendButton: Locator;
  readonly agentGreeting: Locator;
  readonly agentMessage: Locator;
  readonly userMessage: Locator;

  // Flight-related elements
  readonly flightOptions: Locator;
  readonly klmFlightOption: Locator;
  readonly unitedFlightOption: Locator;
  readonly flightSelectionInterface: Locator;

  // Hotel-related elements
  readonly hotelOptions: Locator;
  readonly hotelZephyrOption: Locator;
  readonly ritzCarltonOption: Locator;
  readonly hotelZoeOption: Locator;
  readonly hotelSelectionInterface: Locator;

  // Itinerary and state elements
  readonly itineraryDisplay: Locator;
  readonly selectedFlight: Locator;
  readonly selectedHotel: Locator;
  readonly experienceRecommendations: Locator;

  // Subgraph activity indicators
  readonly activeAgent: Locator;
  readonly supervisorIndicator: Locator;
  readonly flightsAgentIndicator: Locator;
  readonly hotelsAgentIndicator: Locator;
  readonly experiencesAgentIndicator: Locator;

  constructor(page: Page) {
    this.page = page;
    this.agentGreeting = page.getByText(DEFAULT_WELCOME_MESSAGE);
    this.chatInput = CopilotSelectors.chatTextarea(page);
    this.sendButton = CopilotSelectors.sendButton(page);
    this.agentMessage = CopilotSelectors.assistantMessages(page);
    this.userMessage = CopilotSelectors.userMessages(page);

    // Flight selection elements
    this.flightOptions = page.locator('[data-testid*="flight"], .flight-option');
    this.klmFlightOption = page.getByText(/KLM.*\$650.*11h 30m/);
    this.unitedFlightOption = page.getByText(/United.*\$720.*12h 15m/);
    this.flightSelectionInterface = page.locator('[data-testid*="flight-select"], .flight-selection');

    // Hotel selection elements
    this.hotelOptions = page.locator('[data-testid*="hotel"], .hotel-option');
    this.hotelZephyrOption = page.getByText(/Hotel Zephyr.*Fisherman\'s Wharf.*\$280/);
    this.ritzCarltonOption = page.getByText(/Ritz-Carlton.*Nob Hill.*\$550/);
    this.hotelZoeOption = page.getByText(/Hotel Zoe.*Union Square.*\$320/);
    this.hotelSelectionInterface = page.locator('[data-testid*="hotel-select"], .hotel-selection');

    // Itinerary elements
    this.itineraryDisplay = page.locator('[data-testid*="itinerary"], .itinerary');
    this.selectedFlight = page.locator('[data-testid*="selected-flight"], .selected-flight');
    this.selectedHotel = page.locator('[data-testid*="selected-hotel"], .selected-hotel');
    this.experienceRecommendations = page.locator('[data-testid*="experience"], .experience');

    // Agent activity indicators
    this.activeAgent = page.locator('[data-testid*="active-agent"], .active-agent');
    this.supervisorIndicator = page.locator('[data-testid*="supervisor"], .supervisor-active');
    this.flightsAgentIndicator = page.locator('[data-testid*="flights-agent"], .flights-agent-active');
    this.hotelsAgentIndicator = page.locator('[data-testid*="hotels-agent"], .hotels-agent-active');
    this.experiencesAgentIndicator = page.locator('[data-testid*="experiences-agent"], .experiences-agent-active');
  }

  async openChat() {
    // V2 sidebar opens by default (chatDefaultOpen=true), so just wait for it
    await expect(this.agentGreeting).toBeVisible();
  }

  async sendMessage(message: string) {
    await sendChatMessage(this.page, message);
    await awaitLLMResponseDone(this.page);
  }

  async selectFlight(airline: 'KLM' | 'United') {
    const flightOption = airline === 'KLM' ? this.klmFlightOption : this.unitedFlightOption;

    // Wait for flight options to be presented
    await expect(this.flightOptions.first()).toBeVisible();

    // Click on the desired flight option
    await flightOption.click();
  }

  async selectHotel(hotel: 'Zephyr' | 'Ritz-Carlton' | 'Zoe') {
    let hotelOption: Locator;

    switch (hotel) {
      case 'Zephyr':
        hotelOption = this.hotelZephyrOption;
        break;
      case 'Ritz-Carlton':
        hotelOption = this.ritzCarltonOption;
        break;
      case 'Zoe':
        hotelOption = this.hotelZoeOption;
        break;
    }

    // Wait for hotel options to be presented
    await expect(this.hotelOptions.first()).toBeVisible();

    // Click on the desired hotel option
    await hotelOption.click();
  }

  async waitForFlightsAgent() {
    await expect(
      this.page.getByText(/flight.*options|Amsterdam.*San Francisco|KLM|United/i).first()
    ).toBeVisible();
  }

  async waitForHotelsAgent() {
    await expect(
      this.page.getByText(/hotel.*options|accommodation|Zephyr|Ritz-Carlton|Hotel Zoe/i).first()
    ).toBeVisible();
  }

  async waitForExperiencesAgent() {
    await expect(
      this.page.getByText(/experience|activities|restaurant|Pier 39|Golden Gate|Swan Oyster|Tartine/i).first()
    ).toBeVisible();
  }

  async verifyStaticFlightData() {
    await expect(this.page.getByText(/KLM.*\$650.*11h 30m/).first()).toBeVisible();
    await expect(this.page.getByText(/United.*\$720.*12h 15m/).first()).toBeVisible();
  }

  async verifyStaticHotelData() {
    await expect(this.page.getByText(/Hotel Zephyr.*\$280/).first()).toBeVisible();
    await expect(this.page.getByText(/Ritz-Carlton.*\$550/).first()).toBeVisible();
    await expect(this.page.getByText(/Hotel Zoe.*\$320/).first()).toBeVisible();
  }

  async verifyStaticExperienceData() {
    await expect(this.page.getByText('No experiences planned yet')).not.toBeVisible({ timeout: 30000 });

    await expect(this.page.locator('.activity-name').first()).toBeVisible();

    const experienceContent = this.page.locator('.activity-name').first().or(
      this.page.getByText(/Pier 39|Golden Gate Bridge|Swan Oyster Depot|Tartine Bakery/i).first()
    );
    await expect(experienceContent).toBeVisible();
  }

  async verifyItineraryContainsFlight(airline: 'KLM' | 'United') {
    await expect(this.page.getByText(new RegExp(airline, 'i'))).toBeVisible();
  }

  async verifyItineraryContainsHotel(hotel: 'Zephyr' | 'Ritz-Carlton' | 'Zoe') {
    const hotelName = hotel === 'Ritz-Carlton' ? 'Ritz-Carlton' : `Hotel ${hotel}`;
    await expect(this.page.getByText(new RegExp(hotelName, 'i'))).toBeVisible();
  }

  async assertAgentReplyVisible(expectedText: RegExp) {
    await expect(this.agentMessage.last().getByText(expectedText)).toBeVisible();
  }

  async assertUserMessageVisible(message: string) {
    await expect(this.page.getByText(message)).toBeVisible();
  }

  async getAssistantMessageCount(): Promise<number> {
    return this.agentMessage.count();
  }

  async assertMessagesNotLost(countBefore: number) {
    expect(countBefore, "No assistant messages were visible before the interrupt — test precondition failed").toBeGreaterThan(0);
    const countAfter = await this.getAssistantMessageCount();
    expect(countAfter, `Expected at least ${countBefore} assistant messages after interrupt resume, but found ${countAfter}`).toBeGreaterThanOrEqual(countBefore);
  }

  async waitForSupervisorCoordination() {
    await expect(
      this.page.getByText(/supervisor|coordinate|specialist|routing/i).first()
    ).toBeVisible();
  }

  async waitForAgentCompletion() {
    await expect(
      this.page.getByText(/complete|finished|planning.*done|itinerary.*ready/i).first()
    ).toBeVisible();
  }
}
