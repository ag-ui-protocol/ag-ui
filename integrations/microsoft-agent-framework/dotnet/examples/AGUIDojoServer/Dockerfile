# Multi-stage build
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS builder

WORKDIR /app

# Copy csproj and restore dependencies
COPY AGUIDojoServer.csproj .
RUN dotnet restore

# Copy source code
COPY . .

# Build the application
RUN dotnet publish -c Release -o out

# Final stage - runtime image
FROM mcr.microsoft.com/dotnet/aspnet:10.0

WORKDIR /app

# Run as the non-root user that ships with the .NET 8+ images (the Ubuntu 24.04
# base already owns UID 1000, so creating our own user there would fail)
USER $APP_UID

# Copy the built application from builder stage
COPY --from=builder /app/out .

# Expose default ASP.NET Core port
EXPOSE 8080

# Run the application
ENTRYPOINT ["dotnet", "AGUIDojoServer.dll"]
