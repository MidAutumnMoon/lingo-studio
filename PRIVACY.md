# Cherry Studio Privacy Policy

**Updated Date:** October 6, 2026

**Effective Date:** August 20, 2026

Welcome to Cherry Studio (hereinafter referred to as "this Software" or "we"). We place a high priority on protecting your privacy. This Privacy Policy explains how we handle and protect your personal information and data. Please read and understand this policy carefully before using this Software.

## I. Scope of Information We Collect

This Software contains no automatic telemetry. It does not collect, upload, or otherwise transmit usage statistics, feature-activity data, error logs, or crash reports in the background, and it does not attach any persistent unique identifier to the network requests it makes. The only data transmissions this Software directs toward our or third-party servers in connection with its own operation are the three categories below; each is either initiated by you or limited to retrieving public update information.

### (1) Diagnostics You Explicitly Choose to Upload

When you contact us for support, the Software can help you assemble a diagnostics bundle from the data sources you select (for example logs and request traces). A bundle is uploaded to our official service (api.cherry-ai.com) only after you explicitly confirm the upload, together with a short description you provide. You may review and delete the bundle file on your device before and after uploading it.

### (2) Release Notes and Provider Registry Update Checks

To display release notes and keep the built-in model provider registry current, the Software fetches this public information: release notes are fetched on demand from our official endpoint, and registry updates are checked periodically from public hosting services. These requests carry a standard User-Agent header identifying the Software version and your operating system family and CPU architecture (for example, `CherryStudio/1.x (Mac OS X 15; arm64)`), used solely to keep the delivered information compatible with your environment; they do not carry any persistent unique identifier or any of your data. To select the appropriate registry source, the Software also consults a third-party IP-geolocation service, which necessarily receives your IP address for that lookup.

### (3) Local-Only Diagnostic Traces and Logs (Developer Mode)

When you enable Developer Mode, the Software records traces and logs of AI requests on your device to help diagnose problems. These records are stored only on your local device, are never transmitted by the Software itself, and can be deleted from your device at any time. They leave your device only if you deliberately include them in a diagnostics bundle you upload under item (1).

### (4) Our Commitments

We commit that any information reaching our servers through the channels described above:

- Is limited to what is described above and nothing more;
- Will NOT be used for user profiling or targeted advertising, nor sold or otherwise provided to third parties (except as mandatorily required by laws and regulations);
- Will NOT include your API Keys, knowledge base content, or any other sensitive data beyond what you deliberately place in a diagnostics bundle you choose to upload (see Section II for details).

## II. Information We Explicitly Do NOT Collect

To maximize the protection of your privacy and information security, we explicitly commit that we will NOT collect, store, transmit, or process the following data:

- **Your API Keys:** The model service API Key information you input into this Software;
- **Your Conversation Data:** Any conversation data generated during your use of this Software, including but not limited to chat content, instruction information, knowledge base information, vector data, and other custom content (except for the transient relay strictly necessary to complete inference when you use the Built-in Model Services described in Section IV; we do not log or store such content);
- **Personal Identity Information and Sensitive Personal Information:** Any information that could directly or indirectly identify you, as well as sensitive personal information as defined by applicable laws and regulations.

## III. Local Storage and Data Interaction Explanation

**Data Localization:** Your API Keys, historical conversation records, and personal preference settings are by default stored locally on your device. Cherry Studio does not provide cloud synchronization services and will not upload this data to our servers (except for the transient relay strictly necessary to complete inference when you use the Built-in Model Services described in Section IV).

**Direct Calls:** When you use third-party model services that you have configured yourself, this Software acts as a local tool providing interface calling functionality to third-party model services. Your terminal device establishes a direct network connection with the servers of the third-party model providers you configure (e.g., OpenAI, Anthropic), and such data is not relayed through our servers.

**Content Compliance Obligations:** Whether you use the Built-in Model Services described in Section IV or third-party model services that you configure yourself, you shall not use this Software to produce, reproduce, publish, transmit, or disseminate any illegal or harmful information that violates the laws and regulations of the People's Republic of China or the applicable laws and regulations of your country or region of residence, including but not limited to content endangering national security, harming national honor and interests, undermining ethnic unity, spreading rumors, disrupting social order, promoting obscenity, pornography, violence, or infringing upon the legitimate rights and interests of others.

## IV. Built-in Model Services

Cherry Studio provides Built-in Model Services that require no API Key configuration on your part. When you use these services, the prompts, conversation context, and model responses necessary to complete inference are relayed through Cherry Studio's official service.

The relay service processes only the current request. It does not log or store the relevant content, discards it immediately upon completion of the request, and does not use it for any purpose beyond that request.

The upstream model service provider corresponding to a Built-in Model Service will process such request content within the scope of its services, as governed by its own privacy policy.

The built-in models and their service providers may be adjusted according to service conditions. You may also choose to use other model services that you configure yourself.

The Built-in Model Services are provided in reliance on the capabilities of upstream model service providers and may be subject to interruption, delay, or unavailability due to service adjustments, network conditions, or upstream changes. Model outputs are automatically generated by the model; we make no warranty as to their accuracy, completeness, or fitness for any purpose, and you should exercise your own judgment and bear the risks of using such content. To the extent permitted by law, we shall not be liable for any losses arising from your use of the Built-in Model Services.

## V. Privacy Policy Statement Regarding Third-Party Model Service Providers

When you use API Keys for third-party model services that you have applied for and configured yourself to conduct AI conversations, you are effectively receiving services directly from that third-party model service provider:

You shall bear all privacy and compliance risks associated with using third-party model service providers.

Each model provider (e.g., large language model companies) will, in accordance with its own privacy policies and data security measures, process the data you actively input (such as conversation content) and may independently collect other related data within the scope of its services. Such processing and collection activities are beyond the control of this Software and cannot be disabled from within this Software.

If you wish to learn about or disable such data processing and collection activities, please review the privacy policy on the official website of the model service provider you have selected and contact them for instructions on disabling such activities. We assume no responsibility in this regard.

## VI. Special Explanation Regarding Third-Party Services

To facilitate your management and processing of data, in the [Settings] - [Data Settings] section of this Software, we support the following third-party service functions, including but not limited to, that you can choose to configure and use by entering API addresses, usernames, passwords, etc.:

- **Cloud Backup Settings:** WebDAV, S3-compatible storage, Nutstore (坚果云);
- **Third-Party Connections:** Yuque (语雀), Joplin, Obsidian, SiYuan Note (思源笔记), and others.

The third-party services actually supported are as displayed within the client.

When you use the above third-party services through this Software:

The API Keys, passwords, and other credentials you enter are used only locally on your device. This Software does not collect or store such information or data. Please properly safeguard your credentials.

Third-party services are operated independently by their respective service providers. Their data processing activities (including collection, use, storage, and sharing) are governed by those service providers' own privacy policies and terms. We recommend that you carefully read and understand the relevant service provider's privacy policy and terms of service before connecting. You are responsible for using the third-party service in compliance and for assuming all risks and responsibilities associated with using that service. We assume no responsibility for data breaches, loss, or improper processing resulting from your use of third-party services.

Please also be aware that the above third-party service providers may independently collect your data within the scope of their services. Such collection activities are beyond the control of this Software and cannot be disabled from within this Software. If you wish to disable such collection, please contact the relevant third-party service provider for instructions.

## VII. Disclaimer Regarding Third-Party Service Providers and Third-Party Services

### (1) Independence of Third-Party Services

This Software is an open-source software that helps users connect to, configure, and use artificial intelligence models, APIs, network services, and other related services provided by third parties (collectively, "Third-Party Services").

Unless otherwise expressly stated by this Software, Third-Party Services are independently provided, operated, and made subject to liability by the respective third-party service providers. No relationship of agency, joint operation, cooperative operation, guarantee, authorized charging, or other similar legal relationship is formed between this Software and the third-party service providers by reason of this Software providing connection and configuration functionality.

Your configuration or use of Third-Party Services through this Software does not mean that this Software is the provider, seller, charging party, or settlement party of such Third-Party Services.

This Section applies to Third-Party Services configured and used by the user, and does not apply to the Built-in Model Services described in Section IV.

### (2) Third-Party Service Fees and Billing

Whether a Third-Party Service is chargeable, as well as its charging standards, free quotas, model prices, Token prices, cache prices, multipliers, packages, top-up discounts, currency conversion methods, settlement rules, and other billing policies, shall be governed by the rules actually published and enforced by the respective third-party service provider.

This Software does not participate in the actual billing, deduction, top-up, refund, or settlement processes of the third-party service providers, and cannot guarantee real-time access to the latest, complete, and accurate billing information of all third-party service providers.

Fees incurred by users as a result of using Third-Party Services shall be settled by the user and the respective third-party service provider in accordance with the provider's service agreement, pricing policy, and actual usage.

### (3) In-Client Pricing and Related Information

To improve user experience, this Software may display within the client information such as model prices, free status, Token unit prices, context length, model names, model capabilities, or other information related to Third-Party Services.

The above information is for reference only and does not constitute a quotation, billing commitment, free-of-charge commitment, price guarantee, or any other contractual commitment made by this Software or the third-party service provider to the user, nor should it be treated as the sole basis for determining the final charges of a Third-Party Service. This paragraph does not apply where this Software expressly states that such information is provided by the relevant service provider in real time and serves as a formal basis for billing.

Because third-party service providers may adjust prices, models, free-of-charge policies, multipliers, billing methods, or other service rules at any time, the information displayed in this Software may be subject to delays, omissions, errors, invalidation, or inconsistencies with the actual rules of the third-party service providers.

Before using any Third-Party Service that may incur fees, users should verify the latest prices and billing rules on their own through the official channels provided by the respective third-party service provider.

### (4) API Keys and Account Responsibility

When users provide, configure, or authorize the use of API Keys, access tokens, accounts, or other authentication information for Third-Party Services on their own, they shall verify in advance the balance, permissions, free quotas, billing rules, and security status of the corresponding accounts.

Any usage fees, overage fees, balance deductions, or other economic losses arising from a user's configuration, use, or management of third-party accounts, API Keys, or Third-Party Services shall be handled between the user and the respective third-party service provider in accordance with the provider's rules.

### (5) Third-Party Service Anomalies and Disputes

For any service interruption, model change, price adjustment, billing anomaly, duplicate charge, account freeze, insufficient quota, refund dispute, interface error, data loss, service unavailability, or other issues caused by a third-party service provider, the user shall assert rights or seek resolution directly with the respective third-party service provider.

Within a reasonable scope, this Software may provide users with necessary technical information or assistance in troubleshooting depending on the actual circumstances. However, such assistance does not mean that this Software assumes liability for the Third-Party Services, nor does it constitute a guarantee or endorsement of the conduct of the third-party service providers.

The charging, deduction, refund, and service activities independently carried out by third-party service providers shall not be transformed into the conduct or liability of this Software merely because the user uses such Third-Party Services through this Software.

## VIII. Policy Updates and Modifications

This Privacy Policy may be updated from time to time. In the event of any material changes (including but not limited to adjustments to the scope of information collection, modifications to user rights, or changes in data processing practices), we will notify you in advance through prominent notices within the Software, version release notes, or other appropriate means, and will clearly indicate the updated date and effective date in the new version. Please review such updates promptly. Your continued use of the Software after the effective date of the updated policy shall be deemed as your acknowledgment and acceptance of the updated terms.

## IX. Contact Us

If you have any questions regarding this Privacy Policy or Cherry Studio's privacy protection measures, or if you wish to contact us regarding the processing of your information, please feel free to contact us through the following channel:

**Email:** privacy@cherry-ai.com

We will respond within 15 business days after receiving your request.

Thank you for choosing and trusting Cherry Studio. We will continue to provide you with a safe and reliable product experience.
