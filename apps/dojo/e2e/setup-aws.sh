#!/bin/bash

# AWS S3 Video Upload Setup Script
# This script creates the necessary AWS infrastructure for Playwright video uploads

set -e  # Exit on any error

# Configuration
BUCKET_NAME="copilotkit-e2e-smoke-test-recordings-$(openssl rand -hex 4)"
IAM_USER_NAME="copilotkit-e2e-smoke-test-uploader"
POLICY_NAME="CopilotKitE2ESmokeTestVideoUploadPolicy"
AWS_REGION="us-east-1"

echo "🚀 Setting up AWS infrastructure for Playwright video uploads..."
echo "Bucket name: $BUCKET_NAME"
echo "IAM user: $IAM_USER_NAME"
echo "Region: $AWS_REGION"
echo ""

# Check if AWS CLI is installed and configured
if ! command -v aws &> /dev/null; then
    echo "❌ AWS CLI is not installed. Please install it first."
    exit 1
fi

# Check if AWS credentials are configured
if ! aws sts get-caller-identity &> /dev/null; then
    echo "❌ AWS credentials not configured. Run 'aws configure' first."
    exit 1
fi

echo "✅ AWS CLI is configured"

# Step 1: Create S3 Bucket
echo "📦 Creating S3 bucket: $BUCKET_NAME"
aws s3api create-bucket \
    --bucket "$BUCKET_NAME" \
    --region "$AWS_REGION" \
    --create-bucket-configuration LocationConstraint="$AWS_REGION" 2>/dev/null || {
    # Handle us-east-1 special case (no LocationConstraint needed)
    if [ "$AWS_REGION" = "us-east-1" ]; then
        aws s3api create-bucket --bucket "$BUCKET_NAME" --region "$AWS_REGION"
    else
        echo "❌ Failed to create bucket"
        exit 1
    fi
}

# Step 2: Configure bucket for public read access
echo "🔓 Configuring bucket for public read access..."

# Disable block public access
aws s3api put-public-access-block \
    --bucket "$BUCKET_NAME" \
    --public-access-block-configuration \
    "BlockPublicAcls=false,IgnorePublicAcls=false,BlockPublicPolicy=false,RestrictPublicBuckets=false"

# Apply bucket policy for public read access
aws s3api put-bucket-policy --bucket "$BUCKET_NAME" --policy "{
    \"Version\": \"2012-10-17\",
    \"Statement\": [
        {
            \"Sid\": \"PublicReadGetObject\",
            \"Effect\": \"Allow\",
            \"Principal\": \"*\",
            \"Action\": \"s3:GetObject\",
            \"Resource\": \"arn:aws:s3:::$BUCKET_NAME/*\"
        }
    ]
}"

# Step 3: Set up lifecycle policy for automatic cleanup (30 days)
echo "🗂️ Setting up lifecycle policy for automatic cleanup..."
aws s3api put-bucket-lifecycle-configuration \
    --bucket "$BUCKET_NAME" \
    --lifecycle-configuration '{
        "Rules": [
            {
                "ID": "DeleteOldVideos",
                "Status": "Enabled",
                "Filter": {
                    "Prefix": "github-runs/"
                },
                "Expiration": {
                    "Days": 30
                }
            }
        ]
    }'

# Step 4: Create IAM policy for S3 upload permissions
echo "👤 Creating IAM policy..."
POLICY_ARN=$(aws iam create-policy \
    --policy-name "$POLICY_NAME" \
    --policy-document '{
        "Version": "2012-10-17",
        "Statement": [
            {
                "Sid": "S3VideoUploadPermissions",
                "Effect": "Allow",
                "Action": [
                    "s3:PutObject",
                    "s3:PutObjectAcl",
                    "s3:GetObject"
                ],
                "Resource": "arn:aws:s3:::'"$BUCKET_NAME"'/*"
            },
            {
                "Sid": "S3ListBucketPermission",
                "Effect": "Allow",
                "Action": "s3:ListBucket",
                "Resource": "arn:aws:s3:::'"$BUCKET_NAME"'"
            }
        ]
    }' \
    --query 'Policy.Arn' \
    --output text)

echo "✅ Created policy: $POLICY_ARN"

# Step 5: Create IAM user
echo "👤 Creating IAM user: $IAM_USER_NAME"
aws iam create-user --user-name "$IAM_USER_NAME" || {
    echo "⚠️  User might already exist, continuing..."
}

# Step 6: Attach policy to user
echo "🔗 Attaching policy to user..."
aws iam attach-user-policy \
    --user-name "$IAM_USER_NAME" \
    --policy-arn "$POLICY_ARN"

# Step 7: Create access keys
echo "🔑 Creating access keys..."
ACCESS_KEY_OUTPUT=$(aws iam create-access-key --user-name "$IAM_USER_NAME")
ACCESS_KEY_ID=$(echo "$ACCESS_KEY_OUTPUT" | jq -r '.AccessKey.AccessKeyId')
SECRET_ACCESS_KEY=$(echo "$ACCESS_KEY_OUTPUT" | jq -r '.AccessKey.SecretAccessKey')

# No temporary files to clean up

# Step 8: Test the setup
echo "🧪 Testing S3 upload..."
echo "test file" > /tmp/test-upload.txt
aws s3 cp /tmp/test-upload.txt "s3://$BUCKET_NAME/test-upload.txt" \
    --region "$AWS_REGION"

# Test public access
TEST_URL="https://$BUCKET_NAME.s3.$AWS_REGION.amazonaws.com/test-upload.txt"
echo "🌐 Testing public access..."
if curl -s -f "$TEST_URL" > /dev/null; then
    echo "✅ Public access working!"
else
    echo "⚠️  Public access test failed, but bucket is created"
fi

# Clean up test file
aws s3 rm "s3://$BUCKET_NAME/test-upload.txt"
rm -f /tmp/test-upload.txt

echo ""
echo "🎉 AWS Setup Complete!"
echo "===================="
echo ""
echo "📋 Add these to your GitHub repository secrets:"
echo "AWS_ACCESS_KEY_ID: $ACCESS_KEY_ID"
echo "AWS_SECRET_ACCESS_KEY: $SECRET_ACCESS_KEY"
echo ""
echo "📦 S3 Bucket Details:"
echo "Bucket Name: $BUCKET_NAME"
echo "Region: $AWS_REGION"
echo "Public URL Pattern: https://$BUCKET_NAME.s3.$AWS_REGION.amazonaws.com/{path}"
echo ""
echo "🔄 Next Steps:"
echo "1. Add the above secrets to your GitHub repository"
echo "2. Update your Playwright configuration with the bucket name"
echo "3. Run your tests to start uploading videos!"
echo ""
echo "💡 Videos will be automatically deleted after 30 days"
echo "💡 Upload path format: github-runs/{RUN_ID}/{PROJECT}/{filename}.webm" 