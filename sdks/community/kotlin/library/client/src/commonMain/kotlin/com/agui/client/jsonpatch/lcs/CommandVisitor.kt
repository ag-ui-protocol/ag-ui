package com.agui.client.jsonpatch.lcs
/*
 * Licensed to the Apache Software Foundation (ASF) under one or more
 * contributor license agreements.  See the NOTICE file distributed with
 * this work for additional information regarding copyright ownership.
 * The ASF licenses this file to You under the Apache License, Version 2.0
 * (the "License"); you may not use this file except in compliance with
 * the License.  You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * This interface should be implemented by user object to walk
 * through [EditScript] objects.
 *
 *
 * Users should implement this interface in order to walk through
 * the [EditScript] object created by the comparison
 * of two sequences. This is a direct application of the visitor
 * design pattern. The [EditScript.visit]
 * method takes an object implementing this interface as an argument,
 * it will perform the loop over all commands in the script and the
 * proper methods of the user class will be called as the commands are
 * encountered.
 *
 *
 * The implementation of the user visitor class will depend on the
 * need. Here are two examples.
 *
 *
 * The first example is a visitor that build the longest common
 * subsequence:
 * <pre>
 * import org.apache.commons.collections4.comparators.sequence.CommandVisitor;
 *
 * import java.util.ArrayList;
 *
 * public class LongestCommonSubSequence implements CommandVisitor {
 *
 * public LongestCommonSubSequence() {
 * a = new ArrayList();
 * }
 *
 * public void visitInsertCommand(Object object) {
 * }
 *
 * public void visitKeepCommand(Object object) {
 * a.add(object);
 * }
 *
 * public void visitDeleteCommand(Object object) {
 * }
 *
 * public Object[] getSubSequence() {
 * return a.toArray();
 * }
 *
 * private ArrayList a;
 *
 * }
</pre> *
 *
 *
 * The second example is a visitor that shows the commands and the way
 * they transform the first sequence into the second one:
 * <pre>
 * import org.apache.commons.collections4.comparators.sequence.CommandVisitor;
 *
 * import java.util.Arrays;
 * import java.util.ArrayList;
 * import java.util.Iterator;
 *
 * public class ShowVisitor implements CommandVisitor {
 *
 * public ShowVisitor(Object[] sequence1) {
 * v = new ArrayList();
 * v.addAll(Arrays.asList(sequence1));
 * index = 0;
 * }
 *
 * public void visitInsertCommand(Object object) {
 * v.insertElementAt(object, index++);
 * display("insert", object);
 * }
 *
 * public void visitKeepCommand(Object object) {
 * ++index;
 * display("keep  ", object);
 * }
 *
 * public void visitDeleteCommand(Object object) {
 * v.remove(index);
 * display("delete", object);
 * }
 *
 * private void display(String commandName, Object object) {
 * System.out.println(commandName + " " + object + " ->" + this);
 * }
 *
 * public String toString() {
 * StringBuffer buffer = new StringBuffer();
 * for (Iterator iter = v.iterator(); iter.hasNext();) {
 * buffer.append(' ').append(iter.next());
 * }
 * return buffer.toString();
 * }
 *
 * private ArrayList v;
 * private int index;
 *
 * }
</pre> *
 *
 * @since 4.0
 * @version $Id: CommandVisitor.java 1477760 2013-04-30 18:34:03Z tn $
 */
interface CommandVisitor<T> {
	/**
	 * Method called when an insert command is encountered.
	 *
	 * @param object object to insert (this object comes from the second sequence)
	 */
	fun visitInsertCommand(`object`: T)

	/**
	 * Method called when a keep command is encountered.
	 *
	 * @param object object to keep (this object comes from the first sequence)
	 */
	fun visitKeepCommand(`object`: T)

	/**
	 * Method called when a delete command is encountered.
	 *
	 * @param object object to delete (this object comes from the first sequence)
	 */
	fun visitDeleteCommand(`object`: T)
}