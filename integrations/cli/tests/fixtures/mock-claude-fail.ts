#!/usr/bin/env bun
/** Mock claude that exits 2 with a stderr message — exercises the failure path. */
process.stderr.write('mock claude intentional failure\n');
process.exit(2);
