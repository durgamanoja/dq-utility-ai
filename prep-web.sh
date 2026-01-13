#!/bin/sh
DST_FILE_NAME="./web/.env"
STACK_NAME="DQUtilityMergedStack"

echo STACK_NAME=$STACK_NAME
echo "> Setting user passwords for Alice and Bob"
COGNITO_USER_POOL_ID=$(aws cloudformation describe-stacks \
    --stack-name $STACK_NAME \
    --query "Stacks[0].Outputs[?ExportName=='ApaCognitoUserPoolId'].OutputValue" \
    --output text)
echo "COGNITO_USER_POOL_ID=\"$COGNITO_USER_POOL_ID\""
aws cognito-idp admin-set-user-password --user-pool-id $COGNITO_USER_POOL_ID --username Alice --password "Passw0rd@" --permanent
aws cognito-idp admin-set-user-password --user-pool-id $COGNITO_USER_POOL_ID --username Bob --password "Passw0rd@" --permanent

echo "> Injecting exports into $DST_FILE_NAME"
echo "" > $DST_FILE_NAME
COGNITO_SIGNIN_URL=$(aws cloudformation describe-stacks \
    --stack-name $STACK_NAME \
    --query "Stacks[0].Outputs[?ExportName=='ApaCognitoSignInUrl'].OutputValue" \
    --output text)
echo "COGNITO_SIGNIN_URL=\"$COGNITO_SIGNIN_URL\"" >> $DST_FILE_NAME

COGNITO_LOGOUT_URL=$(aws cloudformation describe-stacks \
    --stack-name $STACK_NAME \
    --query "Stacks[0].Outputs[?ExportName=='ApaCognitoLogoutUrl'].OutputValue" \
    --output text)
echo "COGNITO_LOGOUT_URL=\"$COGNITO_LOGOUT_URL\"" >> $DST_FILE_NAME

COGNITO_WELL_KNOWN_URL=$(aws cloudformation describe-stacks \
    --stack-name $STACK_NAME \
    --query "Stacks[0].Outputs[?ExportName=='ApaCognitoWellKnownUrl'].OutputValue" \
    --output text)
echo "COGNITO_WELL_KNOWN_URL=\"$COGNITO_WELL_KNOWN_URL\"" >> $DST_FILE_NAME

COGNITO_CLIENT_ID=$(aws cloudformation describe-stacks \
    --stack-name $STACK_NAME \
    --query "Stacks[0].Outputs[?ExportName=='ApaCognitoClientId'].OutputValue" \
    --output text)
echo "COGNITO_CLIENT_ID=\"$COGNITO_CLIENT_ID\"" >> $DST_FILE_NAME

COGNITO_CLIENT_SECRET=$(aws cloudformation describe-stacks \
    --stack-name $STACK_NAME \
    --query "Stacks[0].Outputs[?ExportName=='ApaCognitoClientSecret'].OutputValue" \
    --output text)
echo "COGNITO_CLIENT_SECRET=\"$COGNITO_CLIENT_SECRET\"" >> $DST_FILE_NAME

AGENT_ENDPOINT_URL=$(aws cloudformation describe-stacks \
    --stack-name $STACK_NAME \
    --query "Stacks[0].Outputs[?ExportName=='DQAgentEndpointUrl'].OutputValue" \
    --output text)
echo "AGENT_ENDPOINT_URL=\"$AGENT_ENDPOINT_URL\"" >> $DST_FILE_NAME

WEB_APP_URL=$(aws cloudformation describe-stacks \
    --stack-name $STACK_NAME \
    --query "Stacks[0].Outputs[?ExportName=='DQWebAppUrl'].OutputValue" \
    --output text)
echo "WEB_APP_URL=\"$WEB_APP_URL\"" >> $DST_FILE_NAME

cat $DST_FILE_NAME
