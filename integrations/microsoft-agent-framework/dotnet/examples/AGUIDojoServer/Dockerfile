# Multi-stage build
FROM mcr.microsoft.com/dotnet/sdk:9.0 AS builder

WORKDIR /app

# Copy csproj and restore dependencies
COPY AGUIDojoServer.csproj .
RUN dotnet restore

# Copy source code
COPY . .

# Build the application
RUN dotnet publish -c Release -o out

# Final stage - runtime image
FROM mcr.microsoft.com/dotnet/aspnet:9.0

WORKDIR /app

# Create non-root user for security
RUN useradd -m -u 1000 dotnet
USER dotnet

# Copy the built application from builder stage
COPY --from=builder /app/out .

# Expose default ASP.NET Core port
EXPOSE 8080

# Run the application
ENTRYPOINT ["dotnet", "AGUIDojoServer.dll"]
