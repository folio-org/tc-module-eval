# License List Management

The Technical Council is responsible for managing the configuration files for this tool, including those that specify how individual dependency licenses are handled in FOLIO.
- config/license-categories.json
- config/license-variation.json
- config/special-exception.json

## Rationale

See [discussion here](https://folio-org.atlassian.net/wiki/spaces/TC/pages/1173782631/Licensing+Questions+Answers+Deliverables#ML%3A-Why-is-our-specific-evaluation-criterion-(%E2%80%9CInclusion-of-third-party-dependencies-complies-with-ASF-3rd-Party-License-Policy-(2)%E2%80%9C)-expected-to-address-that-value%3F) for why the ASF page is our source material.  Mirroring that page's license lists within this tool makes the lists actionable via automation, and allows for FOLIO-specific handling of particular licenses.

## Last Review Date

**PR #1** included ASF page commits made prior to **2025-10-01**.

## Process

1. Review the [Git history](https://github.com/apache/www-site/commits/main/content/legal/resolved.md) for the [ASF 3rd Party License Policy](https://www.apache.org/legal/resolved.html) to identify any changes to the listed licenses -- addition, removal, recategorization, etc. -- since the Last Review Date above.

1. Create a pull request on this repo.
    - Update the Last Review Date section (including pull request number) above.
    - Make any changes to this tool's config files to reflect the ASF changes.

1. TC reviews, approves and merges the PR.
    - In a PR comment, link to meeting notes with any discussion and the approval.

## Scheduled Review

TC will perform this process once per flower release, as indicated on the [Recurring Calendar](https://folio-org.atlassian.net/wiki/spaces/TC/pages/227082271/Recurring+Calendar).

## As Needed

TC will do the same process when a module evaluation reveals a license that has been added/removed/changed on the ASF page since the last review date.  The module evaluation will submit and shepherd that PR.

A FOLIO community member may also request an off-cycle update, for example if they are aware of a license in use in a production or not-yet-reviewed module that is not currently included in this config.

