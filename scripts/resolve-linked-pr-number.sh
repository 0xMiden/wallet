#!/usr/bin/env bash
# Which pull request's description the linked-PR injections (.github/actions/inject-linked-*-pr)
# read, written to $GITHUB_OUTPUT as `number=<N>`, or `number=` for none, which makes the injection
# a no-op. The one argument is the annotation title. Tests: scripts/resolve-linked-pr-number.test.sh.
#
#   pull_request, pull_request_target   the event's own pull request (PR_NUMBER)
#   workflow_dispatch on a branch       the one open pull request in this repository whose head is
#                                       that branch: none is a no-op, more than one fails
#   any other event                     a no-op

set -euo pipefail

title=${1:-resolve-linked-pr-number}
event=${GITHUB_EVENT_NAME:-}
out=${GITHUB_OUTPUT:?GITHUB_OUTPUT is not set}

none() {
  echo "::notice title=${title}::$1"
  echo "number=" >> "$out"
  exit 0
}

case "$event" in
  pull_request | pull_request_target)
    [ -n "${PR_NUMBER:-}" ] || none "No PR number in event payload."
    echo "number=${PR_NUMBER}" >> "$out"
    exit 0
    ;;
  workflow_dispatch) ;;
  *) none "Skipping on event=${event} (only a pull request event, or a workflow_dispatch on a pull request's branch, injects)." ;;
esac

case "${GITHUB_REF:-}" in
  refs/heads/*) branch=${GITHUB_REF#refs/heads/} ;;
  *) none "Skipping a dispatch on ${GITHUB_REF:-an unknown ref}: only a branch is a pull request's head." ;;
esac

# Refused by name, not by lookup: main is the head of every main-into-next sync pull request, and a
# dispatch on either long-lived branch must build exactly what a push there builds.
case "$branch" in
  main | next) none "A dispatch on ${branch} never injects: it builds the published packages, as a push there does." ;;
esac

repo=${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is not set}
# head= is owner:branch, so a fork's branch of the same name never matches. With -X GET the fields
# go out as a URL-encoded query, which a branch name can need.
if ! numbers=$(gh api -X GET "repos/${repo}/pulls" -f state=open -f "head=${repo%%/*}:${branch}" -f per_page=100 \
  --jq '.[].number'); then
  echo "::error title=${title}::Could not list the open pull requests whose head is ${branch}. Can GH_TOKEN read pull requests?"
  exit 1
fi

count=0 found="" number=""
while IFS= read -r n || [ -n "$n" ]; do
  [ -n "$n" ] || continue
  case "$n" in
    *[!0-9]*)
      echo "::error title=${title}::The pull request lookup for ${branch} answered '${n}', not a number."
      exit 1
      ;;
  esac
  count=$((count + 1))
  found="${found:+$found, }#$n"
  number=$n
done <<< "$numbers"

case "$count" in
  0) none "No open pull request in ${repo} has head ${branch}; nothing to inject." ;;
  1)
    echo "::notice title=${title}::Dispatch on ${branch}: reading the linked-PR markers of #${number}."
    echo "number=${number}" >> "$out"
    ;;
  *)
    echo "::error title=${title}::${count} open pull requests have head ${branch} (${found}), so a dispatch cannot tell whose linked PRs to build against. Close all but one, or dispatch from a branch with a single open pull request."
    exit 1
    ;;
esac
