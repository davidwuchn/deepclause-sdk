autojump - A faster way to navigate your file system from the command line
============================================================================

## NAME

autojump - Smart file system navigation tool that learns your directory access patterns

## SYNOPSIS

```
autojump [options] [directory]
j [options] [query]
jc [query]
jo [query]
jco [query]
```

## DESCRIPTION

autojump is a tool that enables fast directory navigation by maintaining a database of directories you access most frequently. It provides intelligent fuzzy matching, weighted directory sorting based on access frequency, and comprehensive cross-platform shell support.

When you use `j` to navigate, autojump matches your search terms against the database and sorts results by weight, so the most frequently accessed directories appear first.
