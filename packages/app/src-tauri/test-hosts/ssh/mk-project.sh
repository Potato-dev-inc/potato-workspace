#!/bin/sh
# Makes the throwaway project the real-sshd BROWSE proof reads (run inside the test container as the test user, script on stdin).
# Everything is under /home/tester. The names are hostile on purpose; the second folder and the symlinks lead OUT of the project.
set -e
cd /home/tester
rm -rf pj pj-evil outside
mkdir -p "pj/sub dir/it's" pj-evil outside
printf 'SECRET\n' > outside/secret.txt
printf 'SIBLING SECRET\n' > pj-evil/secret.txt
cd pj
git init -q -b trunk
git config user.email t@example.invalid
git config user.name tester
printf 'one\n' > kept.txt
printf 'one\n' > "it's changed.txt"
printf 'deep\n' > "sub dir/it's/deep.txt"
git add .
git commit -q -m first
# Changes: a modified file, new files with hostile names, a staged file.
printf 'two\n' > "it's changed.txt"
for n in 'with space' '$(touch tmp-pwned)' '`touch tmp-pwned`' 'a;b|c&d>e<f' '-rf' '--help' '-oProxyCommand=x' '100%s %n' '$HOME' '{a,b}' '!hist' 'back\slash' '~tilde' '*' "say \"hi\"" "caf$(printf '\303\251') $(printf '\346\227\245')"; do
  printf 'content of %s\n' "$n" > "./$n"
done
printf 'h\n' > .hidden
printf 't\n' > ..two
printf 'staged\n' > staged.txt
git add staged.txt
# Names the screen must not show: a newline and a terminal escape.
printf 'x' > "$(printf 'two\nlines')"
printf 'x' > "$(printf 'esc\033[2Jx')"
# Files the read refuses.
printf '\000\237\222\226\000' > bin.dat
head -c 524289 /dev/zero | tr '\000' 'a' > big.txt
head -c 524288 /dev/zero | tr '\000' 'b' > edge.txt
# Links: out of the project (folder, sibling with the same prefix, file) and inside it.
ln -s /home/tester/outside out-dir
ln -s /home/tester/pj-evil sibling-link
ln -s /home/tester/outside/secret.txt out-file
ln -s kept.txt in-file
ln -s "sub dir" in-dir
ln -s ../../../.. "sub dir/up"
mkfifo a-fifo
echo made
