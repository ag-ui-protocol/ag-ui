using System.Text.Json.Serialization;

namespace AGUIDojoServer;

internal sealed class TaskPlan
{
    [JsonPropertyName("steps")]
    public List<TaskPlanStep> Steps { get; set; } = [];
}

internal sealed class TaskPlanStep
{
    [JsonPropertyName("id")]
    public string Id { get; set; } = string.Empty;

    [JsonPropertyName("title")]
    public string Title { get; set; } = string.Empty;

    [JsonPropertyName("summary")]
    public string Summary { get; set; } = string.Empty;
}

internal sealed class UiComponentResponse
{
    [JsonPropertyName("component")]
    public UiComponent Component { get; set; } = new();
}

internal sealed class UiComponent
{
    [JsonPropertyName("title")]
    public string Title { get; set; } = string.Empty;

    [JsonPropertyName("description")]
    public string Description { get; set; } = string.Empty;

    [JsonPropertyName("fields")]
    public List<UiField> Fields { get; set; } = [];
}

internal sealed class UiField
{
    [JsonPropertyName("id")]
    public string Id { get; set; } = string.Empty;

    [JsonPropertyName("label")]
    public string Label { get; set; } = string.Empty;

    [JsonPropertyName("control")]
    public string Control { get; set; } = "text";

    [JsonPropertyName("options")]
    public List<string>? Options { get; set; }
}

internal sealed class RecipeState
{
    [JsonPropertyName("title")]
    public string Title { get; set; } = string.Empty;

    [JsonPropertyName("ingredients")]
    public List<string> Ingredients { get; set; } = [];

    [JsonPropertyName("steps")]
    public List<string> Steps { get; set; } = [];
}

internal sealed class DraftDocument
{
    [JsonPropertyName("sections")]
    public List<DraftSection> Sections { get; set; } = [];
}

internal sealed class DraftSection
{
    [JsonPropertyName("id")]
    public string Id { get; set; } = string.Empty;

    [JsonPropertyName("title")]
    public string Title { get; set; } = string.Empty;

    [JsonPropertyName("content")]
    public string Content { get; set; } = string.Empty;
}

/// <summary>
/// Represents a recipe with all its details including ingredients and instructions.
/// </summary>
internal sealed class RecipeResponse
{
    /// <summary>
    /// Gets or sets the recipe details.
    /// </summary>
    [JsonPropertyName("recipe")]
    public Recipe Recipe { get; set; } = new();
}

/// <summary>
/// Represents a recipe with title, skill level, cooking time, preferences, ingredients, and instructions.
/// </summary>
internal sealed class Recipe
{
    /// <summary>
    /// Gets or sets the title of the recipe.
    /// </summary>
    [JsonPropertyName("title")]
    public string Title { get; set; } = string.Empty;

    /// <summary>
    /// Gets or sets the skill level required for this recipe (e.g., "Beginner", "Intermediate", "Advanced").
    /// </summary>
    [JsonPropertyName("skill_level")]
    public string SkillLevel { get; set; } = string.Empty;

    /// <summary>
    /// Gets or sets the cooking time (e.g., "30 min", "1 hour").
    /// </summary>
    [JsonPropertyName("cooking_time")]
    public string CookingTime { get; set; } = string.Empty;

    /// <summary>
    /// Gets or sets the special preferences or tags for the recipe (e.g., "Quick", "Easy", "Vegetarian").
    /// </summary>
    [JsonPropertyName("special_preferences")]
    public List<string> SpecialPreferences { get; set; } = [];

    /// <summary>
    /// Gets or sets the list of ingredients required for the recipe.
    /// </summary>
    [JsonPropertyName("ingredients")]
    public List<Ingredient> Ingredients { get; set; } = [];

    /// <summary>
    /// Gets or sets the step-by-step instructions for preparing the recipe.
    /// </summary>
    [JsonPropertyName("instructions")]
    public List<string> Instructions { get; set; } = [];
}

/// <summary>
/// Represents an ingredient in a recipe with an icon, name, and amount.
/// </summary>
internal sealed class Ingredient
{
    /// <summary>
    /// Gets or sets the emoji icon representing the ingredient.
    /// </summary>
    [JsonPropertyName("icon")]
    public string Icon { get; set; } = string.Empty;

    /// <summary>
    /// Gets or sets the name of the ingredient.
    /// </summary>
    [JsonPropertyName("name")]
    public string Name { get; set; } = string.Empty;

    /// <summary>
    /// Gets or sets the amount of the ingredient required.
    /// </summary>
    [JsonPropertyName("amount")]
    public string Amount { get; set; } = string.Empty;
}
