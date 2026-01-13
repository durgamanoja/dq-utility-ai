const { Construct } = require('constructs');
const cognito = require('aws-cdk-lib/aws-cognito');
const { CfnOutput, RemovalPolicy, Stack, Fn, Names, Duration } = require('aws-cdk-lib');

class Cognito extends Construct {
    constructor(scope, id, props) {
        super(scope, id, props);
        
        // Use dynamic URLs passed from the merged stack
        const webAppUrl = props.webAppUrl || 'https://placeholder-webapp-url.com';
        const callbackUrls = [`${webAppUrl}/callback`];
        const logoutUrls = [`${webAppUrl}/login`];

        const userPool = new cognito.UserPool(this, 'UserPool', {
            selfSignUpEnabled: false,
            signInAliases: { username: true, email: true },
            removalPolicy: RemovalPolicy.DESTROY
        });

        const userPoolClient = new cognito.UserPoolClient(this, 'UserPoolClient', {
            userPool,
            generateSecret: true,
            authFlows: {
                userPassword: true,
                userSrp: true
            },
            oAuth: {
                flows: {
                    authorizationCodeGrant: true
                },
                scopes: [
                    cognito.OAuthScope.OPENID,
                    cognito.OAuthScope.EMAIL,
                    cognito.OAuthScope.PROFILE
                ],
                callbackUrls: callbackUrls,
                logoutUrls: logoutUrls
            },
            accessTokenValidity: Duration.hours(8),
            idTokenValidity: Duration.hours(8),
            // Explicitly enable OAuth flows
            supportedIdentityProviders: [
                cognito.UserPoolClientIdentityProvider.COGNITO
            ]
        });

        const userPoolRandomId = Names.uniqueId(userPool).slice(-8).toLowerCase();
        const userPoolDomain = userPool.addDomain('UserPoolDomain', {
            cognitoDomain: {
                domainPrefix: `apa-${userPoolRandomId}-dqutility`
            }
        });

        new cognito.CfnUserPoolUser(this, 'AliceUser', {
            userPoolId: userPool.userPoolId,
            messageAction: 'SUPPRESS',
            username: 'Alice',
        });

        new cognito.CfnUserPoolUser(this, 'BobUser', {
            userPoolId: userPool.userPoolId,
            messageAction: 'SUPPRESS',
            username: 'Bob',
        });

        // Outputs
        const region = Stack.of(this).region;
        const cognitoJwksUrl = `https://cognito-idp.${region}.amazonaws.com/${userPool.userPoolId}/.well-known/jwks.json`;
        const cognitoWellKnownUrl = `https://cognito-idp.${region}.amazonaws.com/${userPool.userPoolId}/.well-known/openid-configuration`;
        const cognitoSignInUrl = userPoolDomain.signInUrl(userPoolClient, {
            redirectUri: `${webAppUrl}/callback`
        });
        const cognitoLogoutUrl = `${userPoolDomain.baseUrl()}/logout?client_id=${userPoolClient.userPoolClientId}`;

        new CfnOutput(this, 'CognitoUserPoolId', {
            exportName: 'ApaCognitoUserPoolId',
            value: userPool.userPoolId
        });

        new CfnOutput(this, 'CognitoWellKnownUrl', {
            exportName: 'ApaCognitoWellKnownUrl',
            value: cognitoWellKnownUrl
        });

        new CfnOutput(this, 'CognitoSignInUrl', {
            exportName: 'ApaCognitoSignInUrl',
            value: cognitoSignInUrl
        });

        new CfnOutput(this, 'CognitoLogoutUrl', {
            exportName: 'ApaCognitoLogoutUrl',
            value: cognitoLogoutUrl
        });

        new CfnOutput(this, 'CognitoClientId', {
            exportName: 'ApaCognitoClientId',
            value: userPoolClient.userPoolClientId
        });

        new CfnOutput(this, 'CognitoClientSecret', {
            exportName: 'ApaCognitoClientSecret',
            // unsafeUnwrap() is used here for brevity and simplicity only. 
            // Always use Secrets Manager to store your secrets!!!
            value: userPoolClient.userPoolClientSecret.unsafeUnwrap()
        });

        new CfnOutput(this, 'CognitoJwksUrl', {
            exportName: 'ApaCognitoJwksUrl',
            value: cognitoJwksUrl
        });

        // Store references for external access
        this.userPool = userPool;
        this.userPoolClient = userPoolClient;
        this.userPoolDomain = userPoolDomain;
        this.cognitoJwksUrl = cognitoJwksUrl;
        this.cognitoWellKnownUrl = cognitoWellKnownUrl;
        this.cognitoSignInUrl = cognitoSignInUrl;
        this.cognitoLogoutUrl = cognitoLogoutUrl;
        this.cognitoDomainUrl = userPoolDomain.baseUrl();
    }
}

module.exports = Cognito;
