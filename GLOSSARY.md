# Personal Finance Dashboard

Personal application for consolidating and viewing financial information from institutions selected by its sole user. It is read-only and never initiates payments.

## Language

**Financial Institution**:
A bank or other financial provider that holds an account or issues a credit card for the user.
_Avoid_: Bank, provider

**Open Finance Connection**:
The consented, read-only relationship between the user and a financial institution through which the application obtains financial data.
_Avoid_: Login, integration

**Disconnected Open Finance Connection**:
A former Open Finance Connection for which the Financial Owner ended future data access. Its locally preserved historical data remains available, but it no longer contributes current values to the Consolidated View.
_Avoid_: Deleted connection, removed data

**Reconnection Required**:
The state of an existing Open Finance Connection whose consent must be renewed before the application can resume obtaining financial data.
_Avoid_: Disconnected Open Finance Connection, generic error

**Consent Scope**:
The limited set of read-only financial data that the user authorizes the app to obtain through an Open Finance Connection.
_Avoid_: Payment permission, full access

**Financial Owner**:
The sole person whose CPF identifies the app profile and the financial data that may be connected to it.
_Avoid_: Account holder, customer

**Financial Account**:
An account held by the user at a financial institution, whose available balance may be displayed.
_Avoid_: Account, bank account

**Credit Card**:
A card issued to the user whose purchases create a card balance and statement.
_Avoid_: Credit account

**Institution Card Statement**:
The aggregate amount due across all credit cards issued to the user by one financial institution. A detailed view breaks it down by card.
_Avoid_: Card statement total, invoice

**Card Statement Settlement**:
The transfer from a financial account to pay a credit card statement. It is not an additional expense because the card purchases already record the expense.
_Avoid_: Expense, card purchase

**Consolidated View**:
A dashboard view that combines financial information from all connected financial institutions, while retaining the ability to filter to one institution.
_Avoid_: Global balance, total balance

**Data Freshness**:
The time elapsed since the app last successfully synchronized information from a financial institution.
_Avoid_: Connection status

**Data Availability**:
The financial data types that a financial institution supplies for a particular Open Finance Connection and consent scope. A type can be unavailable when the institution or consent does not supply it.
_Avoid_: Generic error, missing data

**Transaction**:
A recorded financial movement originating from a financial account or credit card. It is not a payment instruction created by the application.
_Avoid_: Entry, debit, credit

**Pending Transaction**:
A transaction reported by an institution that has not yet been confirmed. It is displayed separately and excluded from financial totals.
_Avoid_: Confirmed transaction, posted transaction

**Internal Transfer**:
One movement of money between two financial accounts connected by the user. It is excluded from income and expense analyses.
_Avoid_: Income, expense

**Refund**:
A transaction that reverses all or part of a prior expense. It remains visible while offsetting that expense in financial totals where the relationship is known.
_Avoid_: Negative expense, cancelled purchase

**Transaction Category**:
A user-correctable classification that groups transactions by their financial purpose.
_Avoid_: Tag, label

**Uncategorized Transaction**:
A transaction for which no category has been assigned. It remains included in financial totals and is presented for user review.
_Avoid_: Ignored transaction

**Merchant**:
The payee or seller associated with a transaction, represented by a normalized name while retaining the institution's original description.
_Avoid_: Transaction description, establishment string

**Source Transaction Data**:
The value, date, original description, and originating institution supplied by Open Finance. These fields are immutable in the app.
_Avoid_: Editable transaction, manual entry

**Category Hierarchy**:
A two-level organization of transaction categories consisting of a category and an optional subcategory.
_Avoid_: Unlimited category tree

**Spending Analysis**:
Historical comparison of expenses by category and time period, including seasonal comparisons. It does not predict or recommend future financial decisions.
_Avoid_: Spending map, forecast

**Installment Purchase**:
One purchase recorded as a series of related credit-card transactions, each due in its respective statement period.
_Avoid_: Separate purchases

**Categorization Rule**:
A reusable preference inferred from a user's merchant and category correction and proposed for future transactions with the same source transaction description.
_Avoid_: Automatic category, machine-learning rule
