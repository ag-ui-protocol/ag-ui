import { Page, Locator, expect } from '@playwright/test';

export class SubgraphsPage {
  readonly page: Page;
  readonly travelPlannerButton: Locator;
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
    this.travelPlannerButton = page.getByRole('button', { name: /travel.*planner|subgraphs/i });
    this.agentGreeting = page.getByText(/travel.*planning|supervisor.*coordinate/i);
    this.chatInput = page.getByRole('textbox', { name: 'Type a message...' });
    this.sendButton = page.locator('[data-test-id="copilot-chat-ready"]');
    this.agentMessage = page.locator('.copilotKitAssistantMessage');
    this.userMessage = page.locator('.copilotKitUserMessage');
    
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
    await this.travelPlannerButton.click();
  }

  async sendMessage(message: string) {
    await this.chatInput.click();
    await this.chatInput.fill(message);
    await this.sendButton.click();
  }

  async selectFlight(airline: 'KLM' | 'United') {
    const flightOption = airline === 'KLM' ? this.klmFlightOption : this.unitedFlightOption;
    
    // Wait for flight options to be presented
    await expect(this.flightOptions.first()).toBeVisible({ timeout: 15000 });
    
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
    await expect(this.hotelOptions.first()).toBeVisible({ timeout: 15000 });
    
    // Click on the desired hotel option
    await hotelOption.click();
  }

  async waitForFlightsAgent() {
    // Wait for flights agent to become active (or look for flight-related content)
    // Use .first() to handle multiple matches in strict mode
    await expect(
      this.page.getByText(/flight.*options|Amsterdam.*San Francisco|KLM|United/i).first()
    ).toBeVisible({ timeout: 20000 });
  }

  async waitForHotelsAgent() {
    // Wait for hotels agent to become active (or look for hotel-related content)
    // Use .first() to handle multiple matches in strict mode
    await expect(
      this.page.getByText(/hotel.*options|accommodation|Zephyr|Ritz-Carlton|Hotel Zoe/i).first()
    ).toBeVisible({ timeout: 20000 });
  }

  async waitForExperiencesAgent() {
    // Wait for experiences agent to become active (or look for experience-related content)
    // Use .first() to handle multiple matches in strict mode
    await expect(
      this.page.getByText(/experience|activities|restaurant|Pier 39|Golden Gate|Swan Oyster|Tartine/i).first()
    ).toBeVisible({ timeout: 20000 });
  }

  async verifyStaticFlightData() {
    // Verify the hardcoded flight options are present
    await expect(this.page.getByText(/KLM.*\$650.*11h 30m/).first()).toBeVisible();
    await expect(this.page.getByText(/United.*\$720.*12h 15m/).first()).toBeVisible();
  }

  async verifyStaticHotelData() {
    // Verify the hardcoded hotel options are present
    await expect(this.page.getByText(/Hotel Zephyr.*\$280/).first()).toBeVisible();
    await expect(this.page.getByText(/Ritz-Carlton.*\$550/).first()).toBeVisible();
    await expect(this.page.getByText(/Hotel Zoe.*\$320/).first()).toBeVisible();
  }

  async verifyStaticExperienceData() {
    // Wait for experiences to load - this can take time as it's the final step in the agent flow
    // First ensure we're not stuck in "No experiences planned yet" state
    await expect(this.page.getByText('No experiences planned yet')).not.toBeVisible({ timeout: 20000 }).catch(() => {
      console.log('Still waiting for experiences to load...');
    });
    
    // Wait for actual experience content to appear
    await expect(this.page.locator('.activity-name').first()).toBeVisible({ timeout: 15000 });
    
    // Verify we have meaningful experience content (either static or AI-generated)
    const experienceContent = this.page.locator('.activity-name').first().or(
      this.page.getByText(/Pier 39|Golden Gate Bridge|Swan Oyster Depot|Tartine Bakery/i).first()
    );
    await expect(experienceContent).toBeVisible();
  }

  async verifyItineraryContainsFlight(airline: 'KLM' | 'United') {
    // Check that the selected flight appears in the itinerary or conversation
    await expect(this.page.getByText(new RegExp(airline, 'i'))).toBeVisible();
  }

  async verifyItineraryContainsHotel(hotel: 'Zephyr' | 'Ritz-Carlton' | 'Zoe') {
    // Check that the selected hotel appears in the itinerary or conversation
    const hotelName = hotel === 'Ritz-Carlton' ? 'Ritz-Carlton' : `Hotel ${hotel}`;
    await expect(this.page.getByText(new RegExp(hotelName, 'i'))).toBeVisible();
  }

  async assertAgentReplyVisible(expectedText: RegExp) {
    await expect(this.agentMessage.last().getByText(expectedText)).toBeVisible();
  }

  async assertUserMessageVisible(message: string) {
    await expect(this.page.getByText(message)).toBeVisible();
  }

  async waitForSupervisorCoordination() {
    // Wait for supervisor to appear in the conversation
    await expect(
      this.page.getByText(/supervisor|coordinate|specialist|routing/i).first()
    ).toBeVisible({ timeout: 15000 });
  }

  async waitForAgentCompletion() {
    // Wait for the travel planning process to complete
    await expect(
      this.page.getByText(/complete|finished|planning.*done|itinerary.*ready/i).first()
    ).toBeVisible({ timeout: 30000 });
  }
}